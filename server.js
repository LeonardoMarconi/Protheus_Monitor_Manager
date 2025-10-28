// Protheus Agent with log persistence and UTF-8 WebSocket streaming
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const chokidar = require('chokidar');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors());

const API_KEY = process.env.AGENT_API_KEY || '1234';
const LOG_PATH_FILE = path.join(__dirname, 'logs.json');
const INI_PATH_FILE = './inis.json';
const WEBAPPS_FILE = './webapps.json';

// --- Utils ---

/** Carrega os caminhos de log persistidos. */
function loadLogPaths() {
  try {
    return JSON.parse(fs.readFileSync(LOG_PATH_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** Salva os caminhos de log persistidos. */
function saveLogPaths(map) {
  fs.writeFileSync(LOG_PATH_FILE, JSON.stringify(map, null, 2));
}

/** Carrega os caminhos de INI persistidos. */
function loadIniPaths() {
  if (fs.existsSync(INI_PATH_FILE)) {
    return JSON.parse(fs.readFileSync(INI_PATH_FILE, 'utf8'));
  }
  return {};
}

/** Salva os caminhos de INI persistidos. */
function saveIniPaths(data) {
  fs.writeFileSync(INI_PATH_FILE, JSON.stringify(data, null, 2));
}

/** Carrega a lista de webapps monitorados. */
function loadWebApps() {
  if (fs.existsSync(WEBAPPS_FILE)) {
    return JSON.parse(fs.readFileSync(WEBAPPS_FILE, 'utf8'));
  }
  return {};
}

/** Salva a lista de webapps monitorados. */
function saveWebApps(data) {
  fs.writeFileSync(WEBAPPS_FILE, JSON.stringify(data, null, 2));
}

// --- Middleware Auth ---

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();

  const key = req.headers['x-api-key'] || req.query.key;

  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// --- Rota de Serviços (Windows) ---

/** GET /api/services: Lista serviços filtrados por TOTVS (default). */
app.get('/api/services', (req, res) => {
  const filter = req.query.filter || 'TOTVS';
  // Note: Usa PowerShell para listar e formatar em JSON
  const ps = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    `Get-Service | Where-Object { $_.DisplayName -like '*TOTVS*' } | Select-Object Name, @{ n='Status'; e={ $_.Status.ToString() }},DisplayName | ConvertTo-Json -Compress`,
  ]);

  let out = '';
  ps.stdout.on('data', d => out += d.toString('utf8'));

  ps.on('close', () => {
    try {
      const data = JSON.parse(out || '[]');
      // Garante que o retorno é sempre um array
      res.json(Array.isArray(data) ? data : [data]);
    } catch {
      res.json([]);
    }
  });
});

/** POST /api/service/:name/:action: Inicia/Para/Reinicia um serviço. */
app.post('/api/service/:name/:action', (req, res) => {
  const { name, action } = req.params;
  const map = { start: 'Start-Service', stop: 'Stop-Service', restart: 'Restart-Service' };
  const cmd = map[action];

  if (!cmd) {
    return res.status(400).json({ error: 'invalid action' });
  }

  // Executa o comando e retorna o status atualizado do serviço
  const ps = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    `${cmd} -Name "${name}" -ErrorAction Stop; Get-Service -Name "${name}" | Select-Object Name,Status | ConvertTo-Json -Compress`,
  ]);

  let out = '';
  ps.stdout.on('data', d => out += d.toString('utf8'));

  ps.on('close', () => {
    try {
      res.json(JSON.parse(out));
    } catch {
      // Retorna o output bruto em caso de falha no parse
      res.json({ raw: out });
    }
  });
});

// --- Rotas de Log Path (Caminho) ---

/** GET /api/logpath/:service: Retorna o caminho do log salvo para o serviço. */
app.get('/api/logpath/:service', (req, res) => {
  const svc = req.params.service;
  const agentId = req.ip || req.headers['x-forwarded-for'] || 'local';
  const map = loadLogPaths();
  const key = `${agentId}|${svc}`;

  res.json({ file: map[key] || null });
});

/** POST /api/logpath/:service: Salva o caminho do log para o serviço. */
app.post('/api/logpath/:service', (req, res) => {
  const svc = req.params.service;
  const file = req.body.file;
  const agentId = req.ip || req.headers['x-forwarded-for'] || 'local';
  const map = loadLogPaths();

  const key = `${agentId}|${svc}`;
  map[key] = file;
  saveLogPaths(map);

  res.json({ success: true, service: svc, file });
});

// --- WebSocket stream otimizado com fs.watch (chokidar) ---

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const parsed = new URL(req.url, 'http://localhost');

  if (parsed.pathname === '/logs') {
    const key = parsed.searchParams.get('key');
    if (key !== API_KEY) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    // Lida com a conexão WebSocket se a chave for válida
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, parsed.searchParams));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, params) => {
  const service = params.get('service');
  let file = params.get('file');

  // Tenta carregar o caminho do log salvo se não foi passado via URL
  if (!file && service) {
    const map = loadLogPaths();
    // Nota: O cliente deve passar 'agentId|service' como 'service' se quiser usar o caminho salvo com 'agentId'
    // A lógica original não extrai o agentId aqui, apenas usa 'service' como chave.
    file = map[service];
  }

  if (!file) {
    ws.send(JSON.stringify({ error: 'file or saved path required' }));
    ws.close();
    return;
  }

  if (!fs.existsSync(file)) {
    ws.send(JSON.stringify({ error: 'file not found: ' + file }));
    ws.close();
    return;
  }

  // Envia as últimas 100 linhas iniciais
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-100);
    lines.forEach(line => line && ws.send(JSON.stringify({ line })));
  } catch (e) {
    ws.send(JSON.stringify({ error: 'Erro ao ler log inicial: ' + e.message }));
  }

  // Inicia observação do arquivo com chokidar
  const watcher = chokidar.watch(file, {
    persistent: true,
    usePolling: true,
    interval: 1000,
  });

  let lastSize = fs.statSync(file).size;

  watcher.on('change', () => {
    try {
      const newSize = fs.statSync(file).size;
      if (newSize < lastSize) {
        // Log foi truncado ou rotacionado
        lastSize = newSize;
        return;
      }

      // Cria um stream para ler apenas o novo conteúdo
      const stream = fs.createReadStream(file, {
        encoding: 'utf8',
        start: lastSize,
        end: newSize,
      });

      stream.on('data', chunk => {
        // Envia linha por linha para o cliente, removendo linhas vazias
        chunk.split(/\r?\n/).filter(Boolean).forEach(line => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ line }));
          }
        });
      });

      lastSize = newSize;
    } catch (err) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ error: 'Erro ao ler novo conteúdo: ' + err.message }));
      }
    }
  });

  // Limpa o observador quando a conexão é fechada
  ws.on('close', () => {
    watcher.close();
  });
});

// --- INI HANDLING ---

/** POST /api/inipath/:service: Salva o caminho do arquivo .ini por serviço. */
app.post('/api/inipath/:service', (req, res) => {
  const svc = req.params.service;
  const file = req.body.file;
  const map = loadIniPaths();

  map[svc] = file;
  saveIniPaths(map);
  res.json({ ok: true, service: svc, file });
});

/** GET /api/inipath/:service: Retorna o caminho salvo do .ini. */
app.get('/api/inipath/:service', (req, res) => {
  const svc = req.params.service;
  const map = loadIniPaths();

  res.json({ file: map[svc] || null });
});

/** GET /api/inicontent/:service: Lê o conteúdo do .ini salvo. */
app.get('/api/inicontent/:service', (req, res) => {
  const svc = req.params.service;
  const map = loadIniPaths();
  const file = map[svc];

  if (!file || !fs.existsSync(file)) {
    return res.status(404).json({ error: 'INI file not found' });
  }

  try {
    const content = fs.readFileSync(file, 'utf8');
    res.json({ service: svc, content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- WEBAPP MONITOR ---

const webappStatus = {};

/** POST /api/webapp/:service: Salva/atualiza o endereço do WebApp. */
app.post('/api/webapp/:service', (req, res) => {
  const svc = req.params.service;
  const url = req.body.url;
  const map = loadWebApps();
  map[svc] = url;
  saveWebApps(map);
  res.json({ ok: true, service: svc, url });
});

/** DELETE /api/webapp/:service: Remove o endereço do WebApp. */
app.delete('/api/webapp/:service', (req, res) => {
  const svc = req.params.service;
  const map = loadWebApps();

  if (!map[svc]) {
    return res.status(404).json({ error: 'WebApp não encontrado.' });
  }

  delete map[svc];
  saveWebApps(map);

  res.json({ ok: true, service: svc, message: 'WebApp removido com sucesso.' });
});

/** GET /api/webapps: Obtém lista de webapps configurados. */
app.get('/api/webapps', (req, res) => {
  const map = loadWebApps();
  res.json(map);
});

/** Função de monitoramento interno dos WebApps. */
async function checkWebApps() {
  const apps = loadWebApps();
  for (const [svc, url] of Object.entries(apps)) {
    const start = Date.now();
    try {
      // Nota: O axios deve ser configurado corretamente para o contexto
      const resp = await axios.get(url, { timeout: 5000 });
      const ms = Date.now() - start;
      webappStatus[svc] = { ok: true, ms, lastCheck: new Date().toISOString() };
      console.log(`${svc} WebApp OK (${ms}ms)`);
    } catch (err) {
      webappStatus[svc] = {
        ok: false,
        ms: null,
        lastCheck: new Date().toISOString(),
        error: err.message,
      };
      console.log(`${svc} WebApp FAIL: ${err.message}`);
    }
  }
}

/** GET /api/webappstatus: Rota para consultar status atual. */
app.get('/api/webappstatus', (req, res) => {
  res.json(webappStatus);
});

// Executa o monitor a cada 60s
setInterval(checkWebApps, 60000);
checkWebApps(); // Executa na inicialização

// --- Inicialização do Servidor ---

const port = process.env.PORT || 3000;
server.listen(port, () => console.log('Agent running on port ' + port));