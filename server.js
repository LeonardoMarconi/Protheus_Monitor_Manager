// Protheus Agent with log persistence and UTF-8 WebSocket streaming
const express = require('express');
const { exec } = require('child_process');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const chokidar = require('chokidar');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(cors());

const API_KEY = process.env.AGENT_API_KEY || '1234';
const LOG_PATH_FILE = path.join(__dirname, 'logs.json');
const INI_PATH_FILE = './inis.json';
const WEBAPPS_FILE = './webapps.json';
const ERRORS_FILE = path.join(__dirname, 'errors.json');

const LOGS_FILE = path.join(__dirname, 'logs.json'); 
const filePositions = new Map(); // chave: path -> last read byte offset
const seenBlockHashes = new Set(); // evita duplicatas em memória
const activeWatchers = new Map(); // chave: agent|service|path -> watcher

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
  const map = {
    start: `sc start "${name}"`,
    stop: `sc stop "${name}"`,
    restart: `net stop "${name}" && sc start "${name}"`,
  };
  const cmd = map[action];

  if (!cmd) {
    return res.status(400).json({ error: 'invalid action' });
  }

  exec(cmd, { encoding: 'utf8' }, (err, stdout, stderr) => {
    if (err) {
      console.error(`Erro ao ${action} serviço ${name}:`, stderr || err.message);
      return res.status(500).json({ error: `Falha ao ${action} serviço ${name}` });
    }

    // Após executar, verifica o status atual
    exec(`sc query "${name}"`, { encoding: 'utf8' }, (err2, out2) => {
      if (err2) {
        return res.json({ raw: stdout });
      }

      const match = out2.match(/STATE\s+:\s+\d+\s+(\w+)/);
      const status = match ? match[1] : 'Unknown';
      res.json({ Name: name, Status: status });
    });
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
  const parsed = new URL(req.url, 'http://localhost:3000');

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

  // Envia as últimas 250 linhas iniciais
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-250);
    lines.forEach(line => line && ws.send(JSON.stringify({ line })));
  } catch (e) {
    ws.send(JSON.stringify({ error: 'Erro ao ler log inicial: ' + e.message }));
  }

  // Inicia observação do arquivo com chokidar
  const watcher = chokidar.watch(file, {
    persistent: true,
    usePolling: true,
    interval: 500,
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


// ============================================================================
// MONITORAMENTO DE THREAD ERROR NOS LOGS DO PROTHEUS (com cache de watchers)
// ============================================================================

if (!fs.existsSync(ERRORS_FILE)) fs.writeFileSync(ERRORS_FILE, '[]', 'utf8');

// carrega hashes já existentes (evita duplicatas após restart)
(function loadSeenHashes() {
  try {
    const arr = JSON.parse(fs.readFileSync(ERRORS_FILE, 'utf8'));
    for (const e of arr) {
      if (e._hash) seenBlockHashes.add(e._hash);
      else {
        // tenta gerar hash a partir de conteúdo salvo (fallback)
        const h = crypto.createHash('md5').update((e.line || e.errorText || JSON.stringify(e))).digest('hex');
        seenBlockHashes.add(h);
      }
    }
    console.log(`[INFO] Carregados ${seenBlockHashes.size} hashes de erros existentes.`);
  } catch (err) {
    console.warn('[WARN] Não foi possível carregar errors.json para hashes:', err.message);
  }
})();

function appendErrorLog(data) {
  try {
    // extrai data/hora real da linha THREAD ERROR, se existir
    let logDate = '';
    const match = data.errorText?.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2})/);
    if (match) {
      logDate = `${match[1]} ${match[2]}`;
    }

    // gera hash único usando também data/hora do log
    if (!data._hash) {
      const hashBase = JSON.stringify({
        agent: data.agent,
        service: data.service,
        user: data.user,
        routine: data.routine,
        errorText: data.errorText,
        logDate
      });
      data._hash = crypto.createHash('md5').update(hashBase).digest('hex');
    }

    // evita duplicatas
    if (seenBlockHashes.has(data._hash)) return false;

    // adiciona data/hora real ao objeto, se achada
    if (logDate && !data.errorDate) data.errorDate = logDate;

    const errors = JSON.parse(fs.readFileSync(ERRORS_FILE, 'utf8'));
    errors.push(data);
    fs.writeFileSync(ERRORS_FILE, JSON.stringify(errors, null, 2));

    seenBlockHashes.add(data._hash);
    console.log(`[LOG] Erro salvo: ${data.service} | ${data.user} | ${data.routine} | ${logDate}`);
    return true;
  } catch (err) {
    console.error('[ERRO] Falha ao salvar erro:', err.message);
    return false;
  }
}

/**
 * Extrai TODOS os blocos THREAD ERROR de um texto.
 * Retorna array de objetos { rawBlock, errorText, remarkText, parsed:{ user, module, routine, routineDesc } }
 */
/*function extractAllThreadErrorBlocks(content) {
  // normaliza endings
  // regex pega cada bloco que começa com THREAD ERROR e vai até duplo newline ou EOF
  const regex = /(THREAD ERROR[\s\S]*?)(?=THREAD ERROR|\Z)/gi;
  const blocks = [...content.matchAll(regex)].map(m => m[0]);

  const results = [];

  for (const block of blocks) {
    // busca a linha de erro principal: primeiro trecho "array ..." ou a primeira linha não-metadado
    let errorText = null;
    // tenta encontrar linhas significativas (não linhas que começam com '[' ou 'build:' etc)
    const lines = block.split(/\r?\n/).map(l => l.trim()).filter(l => l.length);
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      // preferimos linhas que contenham 'array' (caso clássico), senão a primeira linha depois do header que não é [tag:]
      if (/array\s+.+/i.test(ln)) { errorText = ln; break; }
      // se linha contem 'on ' e '(' e '.PR' pode ser também
      if (/\bon\s+[A-Z0-9_]+\(/i.test(ln) || /\.[Pp][Rr][WwXx]/.test(ln)) { errorText = ln; break; }
      // ignora lines que são tags [build:, [platform:, [remark:, etc
      if (!/^\[/.test(ln) && !/^\[thread:/i.test(ln) && !/^\[build:/i.test(ln)) {
        // candidate: first non-bracket line that contains letters
        if (!errorText) errorText = ln;
      }
    }
    if (!errorText) errorText = lines.slice(0,3).join(' | ');

    // remark extraction (se houver)
    const remarkMatch = block.match(/\[remark:([\s\S]*?)\]/i);
    const remarkText = remarkMatch ? remarkMatch[1].replace(/\s+/g, ' ').trim() : '';

    // parse remark for user/fonte/obj robustly
    let user = 'Desconhecido', fonte = '', routine = 'N/A', routineDesc = '';

     // Exemplo: "on CTB010ACOLS(CTBA010.PRW)" -> fonte = CTBA010
    const onMatch = errorText.match(/on\s+[A-Z0-9_]+\(([A-Z0-9_]+)\.(PRW|PRX|TLPP)\)/i);
    if (onMatch) {
      fonte = `${onMatch[1]}.${onMatch[2].toUpperCase()}`;
    } else {
      // fallback: pega o primeiro (.PRW|.PRX|.TLPP) se não tiver "on"
      const fallback = errorText.match(/\(([A-Z0-9_]+)\.(PRW|PRX|TLPP)\)/i);
      if (fallback) fonte = `${fallback[1]}.${fallback[2].toUpperCase()}`;
    }

    if (remarkText) {
      // normalize spacing
      //const r = remarkText.replace(/\s+/g, ' ').trim();
      const r = remarkText;

      // user: look for 'Logged' (tolerante aos espaços em torno do :)
      const u = r.match(/Logged\s*:\s*([A-Za-z0-9._\-@]+)/iu)  // allow some extra chars in username
                 || r.match(/Logged\s*:\s*([^\s]+)/iu);
      if (u) user = u[1].trim();

            // Obj: may be "Obj :CTBA010 - Calendário Contábil" or "Obj : CTBA010 - ...", tolerate spacing
      const o = r.match(/Obj\s*:\s*([U_]*[A-Za-z0-9_\.]+)\s*(?:-|$)\s*([^\n\r]*)/iu)
             || r.match(/Obj\s*:\s*([U_]*[A-Za-z0-9_\.]+)/iu);
      if (o) {
        routine = (o[1] || 'N/A').trim();
        routineDesc = (o[2] || '').trim();
      }

      // sometimes Obj appears before Logged; try alternative search
      if (!u) {
        const altU = r.match(/(?:Emp\s*:[^ ]+\s+)?([A-Za-z0-9._\-@]+)\s+[A-Za-z0-9]{4,8}\s+Obj\s*:/i);
        if (altU) user = altU[1].trim();
      }
    }

    results.push({
      rawBlock: block,
      errorText,
      remarkText,
      parsed: { user, fonte, routine, routineDesc }
    });
  }

  return results;
}*/

function extractAllThreadErrorBlocks(content) {
  // captura blocos que contenham THREAD ERROR (mesmo com comentários antes)
  const regex = /(?:\/\*[-=]+[\s\S]*?)?(THREAD ERROR[\s\S]*?)(?=(?:\/\*[-=]+|THREAD ERROR|\Z))/gi;
  const blocks = [...content.matchAll(regex)].map(m => m[1]);
  const results = [];

  for (const block of blocks) {
    // linhas brutas e linhas "trimadas" para navegação
    const rawLines = block.split(/\r?\n/);
    const lines = rawLines.map(l => l.replace(/\r/g, '').trim());

    // 1) header: extrai data/hora do THREAD ERROR (se existir)
    const headerLine = lines.find(l => /^THREAD ERROR/i.test(l)) || '';
    const headerDateMatch = headerLine.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2})/);
    const logDateTime = headerDateMatch ? `${headerDateMatch[1]} ${headerDateMatch[2]}` : '';

    // 2) encontra a primeira linha "significativa" após o header (primeira que não inicia com '[' ou '*')
    let errorText = '';
    let headerIndex = lines.findIndex(l => /^THREAD ERROR/i.test(l));
    if (headerIndex < 0) headerIndex = -1;
    for (let i = headerIndex + 1; i < lines.length; i++) {
      const ln = rawLines[i] !== undefined ? rawLines[i].replace(/\r/g, '') : lines[i];
      const trimmed = (ln || '').trim();
      if (!trimmed) continue;
      if (/^\[/.test(trimmed)) continue; // tags
      if (/^\*/.test(trimmed)) continue; // * SVN Revision
      // usa a linha original (não a .trim) para preservar espaços e conteúdo completo
      errorText = rawLines[i] !== undefined ? rawLines[i].replace(/\r/g, '') : trimmed;
      errorText = errorText.replace(/\r?\n/g, ''); // garantir single-line
      break;
    }
    if (!errorText) {
      // fallback: pega a primeira linha não-vazia do bloco (raw)
      const firstNonEmpty = rawLines.find(r => (r || '').trim());
      errorText = firstNonEmpty ? firstNonEmpty.replace(/\r/g, '') : '';
    }

    // 3) Extrai a data da própria errorText (às vezes tem data na mesma linha)
    //    e mantém essa data como fonte preferencial para delimitar o trecho do 'on'
    const dateInErrorTextMatch = errorText.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2})/);
    const dateForOn = dateInErrorTextMatch ? `${dateInErrorTextMatch[1]} ${dateInErrorTextMatch[2]}` : null;

    // 4) Captura o trecho entre o último " on " antes da data e a data (se data existir)
    let fonte = '';
    if (dateForOn) {
      // pega substring até o índice da data
      const idx = errorText.indexOf(dateInErrorTextMatch[0]);
      if (idx > -1) {
        const beforeDate = errorText.slice(0, idx);
        // procura o último " on " (com espaço) nesse trecho
        const lastOn = beforeDate.toLowerCase().lastIndexOf(' on ');
        if (lastOn > -1) {
          fonte = beforeDate.slice(lastOn + 4).trim(); // remove ' on '
        }
      }
    }

    // 5) se não encontrou fonte acima, faz fallback buscando "on <algo>" até eol, ou pega (X.Y)
    if (!fonte) {
      // tenta pegar último " on " em toda a linha
      const lastOnAll = errorText.toLowerCase().lastIndexOf(' on ');
      if (lastOnAll > -1) {
        fonte = errorText.slice(lastOnAll + 4).trim();
      } else {
        // fallback final: pega primeiro (NOME.EXT) do bloco
        const allFontes = [...block.matchAll(/\(([A-Z0-9_]+)\.(PRW|PRX|TLPP)\)/gi)];
        if (allFontes.length > 0) {
          fonte = `${allFontes[0][1].trim()}.${allFontes[0][2].toUpperCase()}`;
        }
      }
    }

    // 6) Se fonte terminou contendo a data (caso sem separador), limpa a data do final
    if (fonte) {
      const cut = fonte.match(/^(.*?)(\s+\d{2}\/\d{2}\/\d{4}.*)$/);
      if (cut) fonte = cut[1].trim();
    }

    // 7) remark extraction (procura [remark: ...] em todo o bloco)
    const remarkMatch = block.match(/\[remark:([\s\S]*?)\]/i);
    const remarkText = remarkMatch ? remarkMatch[1].replace(/\s+/g, ' ').trim() : '';

    // 8) extrai user, rotina e descricao do remark (tolerante a U_ e acentuação)
    let user = 'Desconhecido';
    let routine = 'N/A';
    let routineDesc = '';
    if (remarkText) {
      const u = remarkText.match(/Logged\s*:\s*([A-Z0-9._\-@]+)/i) || remarkText.match(/Logged\s*:\s*([^\s]+)/i);
      if (u) user = u[1].trim();

      const o = remarkText.match(/Obj\s*:\s*([U_]*[A-Z0-9_]+)\s*(?:-\s*(.+))?/i);
      if (o) {
        routine = (o[1] || 'N/A').trim();
        routineDesc = (o[2] || '').trim();
      }
    }

    // 9) captura número da linha, se houver, diretamente na errorText
    let lineNumber = null;
    const lnMatch = errorText.match(/line\s*:\s*(\d+)/i);
    if (lnMatch) lineNumber = parseInt(lnMatch[1], 10);

    // 10) garante que errorText fique com a linha inteira (sem corte)
    errorText = (errorText || '').trim();

    // 11) devolve resultado
    results.push({
      logDateTime: logDateTime || '',   // data/hora do header THREAD ERROR
      errorText,
      remarkText,
      parsed: {
        user,
        fonte,
        routine,
        routineDesc
      },
      rawBlock: block
    });
  }

  return results;
}


/**
 * monitorLogForErrors: lê o arquivo inteiro inicialmente, processa todos os blocos Thread Error
 * e depois passa a processar apenas o acréscimo (após filePositions[path]).
 */
function monitorLogForErrors(agentName, serviceName, logPath) {
  try {
    if (!fs.existsSync(logPath)) {
      console.warn(`[WARN] logPath não existe: ${logPath}`);
      return;
    }

    const key = `${agentName}|${serviceName}|${logPath}`;
    if (activeWatchers.has(key)) {
      console.log(`[INFO] watcher já ativo para ${serviceName}`);
      return;
    }

    // initialize last position if not present
    if (!filePositions.has(logPath)) {
      filePositions.set(logPath, 0);
    }

    // process existing content once
    try {
      const content = fs.readFileSync(logPath, 'utf8');
      const blocks = extractAllThreadErrorBlocks(content);
      for (const b of blocks) {
        // create object for saving
        const obj = {
          timestamp: new Date().toISOString(),
          agent: agentName,
          service: serviceName,
          user: b.parsed.user,
          fonte: b.parsed.fonte,
          routine: b.parsed.routine,
          routineDesc: b.parsed.routineDesc,
          errorText: b.errorText,
          line: b.rawBlock
        };
        // compute hash inside appendErrorLog
        appendErrorLog(obj);
      }

      // set filePositions to file size so future reads only get new data
      const st = fs.statSync(logPath);
      filePositions.set(logPath, st.size);
    } catch (err) {
      console.warn(`[WARN] falha na leitura inicial de ${logPath}:`, err.message);
    }

    // create watcher - ignoreInitial: true is okay because we already processed initial content
    const watcherError = chokidar.watch(logPath, { persistent: true, ignoreInitial: true });
    activeWatchers.set(key, watcherError);

    watcherError.on('change', (pathChanged) => {
      try {
        const stat = fs.statSync(pathChanged);
        const lastPos = filePositions.get(pathChanged) || 0;
        let start = Math.max(0, lastPos - 4096); // back a bit to capture partial lines safely
        const stream = fs.createReadStream(pathChanged, { encoding: 'utf8', start });
        let buf = '';
        stream.on('data', chunk => buf += chunk);
        stream.on('end', () => {
          // we may have read from start; take the tail from lastPos
          const tail = buf.slice(Math.max(0, buf.length - (stat.size - lastPos)));
          const blocks = extractAllThreadErrorBlocks(tail);
          for (const b of blocks) {
            const obj = {
              timestamp: new Date().toISOString(),
              agent: agentName,
              service: serviceName,
              user: b.parsed.user,
              fonte: b.parsed.fonte,
              routine: b.parsed.routine,
              routineDesc: b.parsed.routineDesc,
              errorText: b.errorText,
              line: b.rawBlock
            };
            appendErrorLog(obj);
          }
          // update last position
          filePositions.set(pathChanged, stat.size);
        });
      } catch (err) {
        console.error(`[ERRO] ao processar mudança em ${serviceName}:`, err.message);
      }
    });

    watcherError.on('error', err => {
      console.error(`[ERRO] watcher ${serviceName}:`, err.message);
      try { watcherError.close(); } catch (e) {}
      activeWatchers.delete(key);
    });

    console.log(`[INFO] monitorando ${serviceName} -> ${logPath}`);
  } catch (err) {
    console.error('[ERRO] monitorLogForErrors falhou:', err.message);
  }
}

/**
 * Inicializa monitoramento com base em logs.json
 */
function initAutomaticLogMonitoring() {
  try {
    if (!fs.existsSync(LOGS_FILE)) {
      console.warn('[WARN] logs.json não encontrado; monitoramento automático não iniciado.');
      return;
    }
    const logs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
    const entries = Object.entries(logs);
    console.log(`[INFO] iniciando monitor automático para ${entries.length} entradas`);
    for (const [k, p] of entries) {
      const parts = k.split('|');
      let ag = parts[0] || 'AGENTE';
      if (ag.startsWith('::ffff:')) ag = ag.replace('::ffff:', '');
      const svc = parts[1] || 'SERVICO';
      if (fs.existsSync(p)) {
        monitorLogForErrors(ag, svc, p);
      } else {
        console.warn(`[WARN] arquivo de log não existe: ${p}`);
      }
    }
  } catch (err) {
    console.error('[ERRO] initAutomaticLogMonitoring:', err.message);
  }
}

// ==========================================================
// GET /api/errors  →  retorna todos os erros registrados
// ==========================================================
const errorsPath = path.join(__dirname, 'errors.json');

app.get('/api/errors', async (req, res) => {
  try {
    if (!fs.existsSync(errorsPath)) {
      return res.status(200).json([]);
    }

    const raw = await fs.promises.readFile(errorsPath, 'utf-8');
    const data = JSON.parse(raw || '[]');

    // opcional: ordenar por data mais recente
    data.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    console.log(`[API] ${req.ip} consultou /api/errors (${data.length} erros)`);
    res.json(data);
  } catch (err) {
    console.error('[API] Erro ao ler errors.json:', err.message);
    res.status(500).json({ error: 'Falha ao ler arquivo de erros.' });
  }
});
// ==========================================================
// GET /api/counts → Retorna quantidades de Servers, WebApps e Errors
// ==========================================================
app.get('/api/counts', (req, res) => {
  try {
    // Servers: simulamos leitura via Get-Service (ajuste se já tiver cache)
    const servers = []; 
    try {
      const raw = fs.readFileSync(LOG_PATH_FILE, 'utf8');
      const map = JSON.parse(raw || '{}');
      for (const k of Object.keys(map)) {
        if (k.toLowerCase().includes('TOTVS')) servers.push(k);
      }
    } catch {}

    const webapps = Object.keys(loadWebApps() || {}).length;

    let errors = 0;
    if (fs.existsSync(ERRORS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(ERRORS_FILE, 'utf8'));
      errors = arr.length;
    }

    res.json({
      servers: servers.length,
      webapps,
      errors
    });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao obter contagens' });
  }
});


// Executa o monitor a cada 60s
setInterval(initAutomaticLogMonitoring, 60000);
initAutomaticLogMonitoring();

// Executa o monitor a cada 60s
setInterval(checkWebApps, 60000);
checkWebApps(); // Executa na inicialização

const port = process.env.PORT || 3000;
server.listen(port, () => console.log('Agent running on port ' + port));
