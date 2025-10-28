// Constantes e Elementos do DOM
const logsEl = document.getElementById('logs');
const agentList = document.getElementById('agentList');
const toggleTheme = document.getElementById('toggleTheme');

// Variável global (ou de escopo do módulo) para armazenar as contagens do log atual
let logCounters = { ERROR: 0, WARN: 0, INFO: 0, TOTAL: 0 };
const MAX_LINES = 2000;
let allLines = []; // Buffer para todas as linhas recebidas

document.getElementById('btnOpenWindow').onclick = () => {
  chrome.windows.create({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    width: 1024,
    height: 920,
  });
};

/**
 * Exibe um alerta temporário na tela.
 * @param {string} msg Mensagem a ser exibida.
 * @param {string} type Tipo do alerta (info, success, warning, danger).
 */
async function showAlert(msg, type = 'info') {
  const a = document.getElementById('alertArea');
  const d = document.createElement('div');
  d.className = `alert alert-${type} alert-dismissible fade show`;
  d.innerHTML = `${msg}<button type="button" class="btn-close" data-bs-dismiss="alert"></button>`;
  a.appendChild(d);
  setTimeout(() => d.remove(), 4000);
}

// --- Gerenciamento de Tema ---

toggleTheme.onclick = async () => {
  document.body.classList.toggle('theme-dark');
  document.body.classList.toggle('theme-light');
  await chrome.storage.local.set({
    theme: document.body.classList.contains('theme-dark') ? 'dark' : 'light',
  });
};

(async () => {
  const s = await chrome.storage.local.get('theme');
  if (s.theme === 'dark') {
    document.body.classList.add('theme-dark');
  }
})();

// --- Gerenciamento de Agentes ---

async function getAgents() {
  const s = await chrome.storage.local.get('agents');
  return s.agents || [];
}

async function saveAgents(a) {
  await chrome.storage.local.set({ agents: a });
}

document.getElementById('btnAddAgent').onclick = async () => {
  const n = prompt('Nome:');
  if (!n) return;

  const u = prompt('URL:');
  if (!u) return;

  const k = prompt('API Key:');
  if (!k) return;

  const a = await getAgents();
  a.push({ name: n, url: u, key: k });
  await saveAgents(a);

  showAlert('Agente adicionado', 'success');
  renderAgents();
};

async function deleteAgent(agentName) {
  const data = await chrome.storage.local.get('agents');
  const agents = data.agents || [];
  const updated = agents.filter(a => a.name !== agentName);
  await chrome.storage.local.set({ agents: updated });
}

async function renderAgents() {
  const agents = await getAgents();
  agentList.innerHTML = '';

  if (!agents.length) {
    agentList.innerHTML = '<div class="alert alert-warning">Nenhum agente configurado.</div>';
    return;
  }

  for (let i = 0; i < agents.length; i++) {
    const ag = agents[i];
    const c = document.createElement('div');
    c.className = 'card mb-2';
    c.innerHTML = `
      <div class="card-body w-100 mx-auto p-10">
        <div class="d-flex justify-content-between align-items-center mb-1">
          <h5 id="titulo"><i class="bi bi-hdd-rack"></i> ${ag.name} - (${ag.url})</h5>
          <button class="btn btn-sm btn-danger" title="Excluir agente">
            <i class="bi bi-trash3-fill"></i>
          </button>
        </div>
        <div id="svc${i}">Carregando...</div>
      </div>
    `;

    // Adiciona evento de exclusão
    const btnDelete = c.querySelector('button');
    btnDelete.addEventListener('click', async () => {
      if (confirm(`Deseja realmente excluir o agente "${ag.name}"?`)) {
        await deleteAgent(ag.name);
        showAlert(`Agente "${ag.name}" removido com sucesso.`, 'success');
        renderAgents(); // atualiza a lista
      }
    });

    agentList.appendChild(c);
    fetchServices(ag, i);
  }
}

async function fetchServices(ag, i) {
  const el = document.getElementById(`svc${i}`);

  try {
    const r = await fetch(`${ag.url}/api/services?filter=TOTVS`, {
      headers: { 'x-api-key': ag.key },
    });

    if (!r.ok) throw new Error(await r.text());
    const list = await r.json();

    el.innerHTML = '';

    if (!list.length) {
      el.innerHTML = '<div class="text-muted">Nenhum serviço encontrado neste agente.</div>';
      return;
    }

    // Calcula totais por status
    const running = list.filter(s => s.Status === 'Running').length;
    const stopped = list.filter(s => s.Status === 'Stopped').length;
    const total = list.length;

    // Cria contador colorido
    const countDiv = document.createElement('div');
    countDiv.className = 'mb-2';
    countDiv.innerHTML = `
      <span class="text-success me-3"><i class="bi bi-folder-check"></i> Rodando: ${running}</span>
      <span class="text-danger me-3"><i class="bi bi-folder-x"></i> Parados: ${stopped}</span>
      <span class="text-primary me-3"><i class="bi bi-folder2-open"></i> Total: ${total}</span>
    `;
    el.appendChild(countDiv);

    // Renderiza lista de serviços
    list.forEach(s => {
      const div = document.createElement('div');
      const n = s.Name, st = s.Status, dn = s.DisplayName;
      let color = 'warning';
      if (st === 'Running') color = 'success';
      else if (st === 'Stopped') color = 'danger';

      div.innerHTML = `
        <strong class="mb-2"><i class="bi bi-terminal-fill"></i> ${dn}</strong>
        - <small class="mb-2">${n}</small> -
        <span class="mb-2 badge text-bg-${color}">${st}</span><br>

        <button class="mb-4 btn btn-sm btn-success me-1"><i class="bi bi-play-circle"></i> Start</button>
        <button class="mb-4 btn btn-sm btn-danger me-1"><i class="bi bi-stop-circle"></i> Stop</button>
        <button class="mb-4 btn btn-sm btn-warning me-1"><i class="bi bi-arrow-clockwise"></i> Restart</button>
        <button class="mb-4 btn btn-sm btn-secondary"><i class="bi bi-file-code"></i> Ver Log</button>
        <button class="mb-4 btn btn-sm btn-info"><i class="bi bi-gear"></i> Ver INI</button>
      `;

      const [b1, b2, b3, b4, b5] = div.querySelectorAll('button');
      b1.onclick = () => controlService(ag, n, 'start');
      b2.onclick = () => controlService(ag, n, 'stop');
      b3.onclick = () => controlService(ag, n, 'restart');
      b4.onclick = () => openLog(ag, n);
      b5.onclick = () => openIni(ag, n);

      el.appendChild(div);
    });
  } catch (e) {
    el.innerHTML = `<div class="text-danger">Erro ao carregar serviços: ${e.message}</div>`;
  }
}

async function controlService(agent, svc, act) {
  const actionLabel = act.charAt(0).toUpperCase() + act.slice(1);
  showAlert(`Executando ${actionLabel} em ${svc}...`, 'warning');

  // Desativa botões relevantes
  const buttons = [...document.querySelectorAll('button')].filter(btn => btn.textContent.toLowerCase().includes(act));
  buttons.forEach(b => {
    b.disabled = true;
    b.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
  });

  try {
    // Ação start/stop/restart
    const resp = await fetch(`${agent.url}/api/service/${svc}/${act}`, {
      method: 'POST',
      headers: { 'x-api-key': agent.key },
    });
    // const data = await resp.json(); // Desnecessário, pois o wait fará o cheque final
    if (!resp.ok) throw new Error(`Status ${resp.status}`);

    showAlert(`Comando ${actionLabel} enviado para ${svc}...`, 'info');

    // Espera até o status mudar
    const finalStatus = await waitForServiceStatus(agent, svc, act);
    showAlert(`Serviço ${svc} agora está ${finalStatus}.`, 'success');

    // Atualiza o card do agente
    await renderAgents();
  } catch (err) {
    showAlert(`Erro ao ${actionLabel} serviço ${svc}: ${err.message}`, 'danger');
  } finally {
    // Reativa e atualiza botões
    buttons.forEach(b => {
      b.disabled = false;
      // Revertendo o texto original é mais robusto
      if (act === 'start') b.innerHTML = '<i class="bi bi-play-circle"></i> Start';
      else if (act === 'stop') b.innerHTML = '<i class="bi bi-stop-circle"></i> Stop';
      else if (act === 'restart') b.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Restart';
    });
  }
}

// Aguarda até que o status do serviço mude (ou tempo limite)
async function waitForServiceStatus(agent, svc, act, timeoutMs = 25000) {
  const expected = act === 'start' || act === 'restart' ? 'Running' : 'Stopped';
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const r = await fetch(`${agent.url}/api/services?filter=${svc}`, {
        headers: { 'x-api-key': agent.key },
      });
      const list = await r.json();
      const current = Array.isArray(list) && list.find(s => s.Name === svc);

      if (current && current.Status === expected) {
        return current.Status;
      }
    } catch (e) {
      console.warn('Polling error:', e.message);
    }
    await new Promise(r => setTimeout(r, 500)); // espera 2s entre as verificações
  }

  throw new Error(`Tempo limite: serviço ${svc} não mudou de status para ${expected} em ${timeoutMs / 1000}s`);
}

// --- Funções de Log e INI ---

/** Atualiza a exibição visual dos contadores no modal. */
function updateCountersDisplay() {
  const el = document.getElementById('logCounterDisplay');
  if (el) {
    el.innerHTML = `
      <span class="text-danger me-3"><i class="bi bi-x-octagon-fill"></i> ERROR: ${logCounters.ERROR}</span>
      <span class="text-warning me-3"><i class="bi bi-exclamation-triangle-fill"></i> WARN: ${logCounters.WARN}</span>
      <span class="text-success me-3"><i class="bi bi-info-circle-fill"></i> INFO: ${logCounters.INFO}</span>
      <span class="text-white"><i class="bi bi-list-ol"></i> TOTAL: ${logCounters.TOTAL}</span>
    `;
  }
}

/** Adiciona e processa uma nova linha de log. */
function appendLine(line) {
  // 1. Lógica de contagem
  logCounters.TOTAL++; 
  
  // Nota: Adicione um espaço no final de WARN e INFO para evitar contagem de palavras como 'WARNING' ou 'INFORMATION'
  if (line.toUpperCase().includes('[ERROR]')) {
    logCounters.ERROR++;
  } else if (line.toUpperCase().includes('[WARN ]')) {
    logCounters.WARN++;
  } else if (line.toUpperCase().includes('[INFO ]')) {
    logCounters.INFO++;
  }

  updateCountersDisplay(); // Atualiza o display do contador

  // 2. Lógica de Buffer
  allLines.push(line);
  if (allLines.length > MAX_LINES) allLines = allLines.slice(-MAX_LINES);
  
  // 3. Lógica de Filtro
  applyFilter();
}

/** Aplica o filtro atual ao buffer de linhas e renderiza. */
function applyFilter() {
  const filterSelect = document.getElementById('logFilter');
  if (!filterSelect) return;

  const filter = filterSelect.value;
  let filtered = allLines;
  if (filter !== '' && filter !== 'ALL') {
    filtered = allLines.filter(l => l.includes(filter));
  }

  logsEl.innerHTML = ''; // limpa log atual

  filtered.forEach(line => {
    const div = document.createElement('div');
    div.style.whiteSpace = 'pre-wrap';

    // Colorização por tipo
    if (line.toUpperCase().includes('[ERROR]')) div.style.color = '#ff5555';
    else if (line.toUpperCase().includes('[FATAL]')) div.style.color = '#ff5555';
    else if (line.toUpperCase().includes('Erro - ')) div.style.color = '#ff5555';
    else if (line.toUpperCase().includes('Erro : ')) div.style.color = '#ff5555';
    else if (line.toUpperCase().includes('[WARN ]')) div.style.color = '#ffcc00';
    else if (line.toUpperCase().includes('[INFO ]')) div.style.color = '#00ff99';
    else div.style.color = '#ccc';

    div.textContent = line;
    logsEl.appendChild(div);
  });

  logsEl.scrollTop = logsEl.scrollHeight;
}


async function openLog(agent, svc) {
  try {
    // 1. Obtém/Define caminho do log
    const resp = await fetch(`${agent.url}/api/logpath/${svc}`, {
      headers: { 'x-api-key': agent.key },
    });
    const { file } = await resp.json();
    let f = file;

    if (f) {
      const alterar = confirm(`O caminho atual do log é:\n${f}\n\nDeseja alterar?`);
      if (alterar) f = null;
    }

    if (!f) {
      f = prompt(`Informe o caminho completo do log para o serviço ${svc}:`);
      if (!f) return;

      await fetch(`${agent.url}/api/logpath/${svc}`, {
        method: 'POST',
        headers: {
          'x-api-key': agent.key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file: f }),
      });
    }

    // 2. Prepara e exibe o Modal
    document.getElementById('logModalLabel').textContent = `Console Log - ${svc}`;
    const logModal = new bootstrap.Modal(document.getElementById('logModal'));
    logModal.show();
    logsEl.textContent = `[Conectando ao log de ${svc}...]\n`;

    // Resetar contadores e buffer ao abrir
    logCounters = { ERROR: 0, WARN: 0, INFO: 0, TOTAL: 0 };
    allLines = [];

    // 3. Cria Barra de Controle (Filtro + Salvar + Contadores)
    let controlBar = document.getElementById('logControlBar');
    if (!controlBar) {
      controlBar = document.createElement('div');
      controlBar.id = 'logControlBar';
      controlBar.className = 'm-3 d-flex justify-content-between align-items-center';

      // Seletor de filtro
      const filterSelect = document.createElement('select');
      filterSelect.id = 'logFilter';
      filterSelect.className = 'form-select form-select-sm w-auto';
      filterSelect.innerHTML = `
        <option value="">-- Filtre o Log pelas TAG's --</option>
        <option value="ALL">Todos</option>
        <option value="[INFO ]">[INFO]</option>
        <option value="[WARN ]">[WARN]</option>
        <option value="[ERROR]">[ERROR]</option>
      `;

      // Display de contadores (NOVO ELEMENTO)
      const counterDisplay = document.createElement('div');
      counterDisplay.id = 'logCounterDisplay';
      counterDisplay.className = 'ms-auto me-3'; // Adiciona margem para separar do botão

      // Botão salvar log
      const saveBtn = document.createElement('button');
      saveBtn.id = 'btnSaveLog';
      saveBtn.className = 'btn btn-sm btn-outline-light';
      saveBtn.innerHTML = '<i class="bi bi-save"></i> Salvar Log';

      controlBar.appendChild(filterSelect);
      controlBar.appendChild(counterDisplay); // Adiciona o display dos contadores
      controlBar.appendChild(saveBtn);
      
      const modalHeader = document.querySelector('#logModal .modal-header');
      modalHeader.insertAdjacentElement('afterend', controlBar); // Coloca após o header

      // Evento de salvar
      saveBtn.onclick = () => {
        const blob = new Blob([logsEl.innerText], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${svc}_console_log.txt`;
        a.click();
        URL.revokeObjectURL(url);
      };
      
      filterSelect.onchange = applyFilter;

    } else {
      // Se a barra já existe, apenas garante que o filtro e o contador estão visíveis
      controlBar.style.display = 'flex';
    }
    
    // Força a atualização inicial do display, que deve estar zerado
    updateCountersDisplay();


    // 4. Conexão e Lógica do WebSocket
    const wsUrl = agent.url.replace('http://', 'ws://').replace('https://', 'wss://');
    const fullUrl = `${wsUrl}/logs?key=${agent.key}&service=${encodeURIComponent(svc)}&file=${encodeURIComponent(f)}`;

    function connectWebSocket(retryCount = 0) {
      const ws = new WebSocket(fullUrl);

      ws.addEventListener('open', () => appendLine(`[Conectado ao serviço ${svc}]`));
      ws.addEventListener('message', e => {
        const d = JSON.parse(e.data);
        if (d.line) appendLine(d.line.replace(/\r/g, ''));
        else if (d.error) appendLine(`[erro] ${d.error.replace(/\r/g, '')}`);
      });

      ws.addEventListener('close', () => {
        appendLine(`[Conexão encerrada]`);
        if (retryCount < 5) {
          const delay = 3000 * (retryCount + 1);
          appendLine(`[Tentando reconectar em ${delay / 1000}s...]`);
          setTimeout(() => connectWebSocket(retryCount + 1), delay);
        } else {
          appendLine(`[Falha ao reconectar após várias tentativas.]`);
        }
      });

      ws.addEventListener('error', err => {
        appendLine(`[Erro WebSocket: ${err.message}]`);
        ws.close();
      });

      // Fecha o WS e oculta a barra de controle quando o modal é fechado
      const modalElement = document.getElementById('logModal');
      modalElement.addEventListener('hidden.bs.modal', () => {
        ws.close();
        if (controlBar) controlBar.style.display = 'none'; // Oculta a barra ao fechar
      }, { once: true });
    }

    connectWebSocket();
  } catch (e) {
    showAlert(`Erro ao abrir log: ${e.message}`, 'danger');
  }
}

async function openIni(agent, svc) {
  try {
    // Esconde a barra de controle de Log ao exibir o INI
    const controlBar = document.getElementById('logControlBar');
    if (controlBar) controlBar.style.display = 'none'; 

    const resp = await fetch(`${agent.url}/api/inipath/${svc}`, {
      headers: { 'x-api-key': agent.key }
    });
    const { file } = await resp.json();
    let f = file;

    // Permite revisar ou corrigir caminho
    if (f) {
      const alterar = confirm(`O caminho atual do INI é:\n${f}\n\nDeseja alterar?`);
      if (alterar) f = null;
    }

    if (!f) {
      f = prompt(`Informe o caminho completo do arquivo .INI para ${svc}:`);
      if (!f) return;

      await fetch(`${agent.url}/api/inipath/${svc}`, {
        method: 'POST',
        headers: {
          'x-api-key': agent.key,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file: f })
      });
    }

    // Busca o conteúdo do .INI
    const iniResp = await fetch(`${agent.url}/api/inicontent/${svc}`, {
      headers: { 'x-api-key': agent.key }
    });

    if (!iniResp.ok) throw new Error(await iniResp.text());
    const data = await iniResp.json();

    // Mostra o INI no mesmo modal do log
    const logsEl = document.getElementById('logs');
    logsEl.textContent = data.content;
    const logModal = new bootstrap.Modal(document.getElementById('logModal'));
    document.getElementById('logModalLabel').textContent = `Configuração INI - ${svc}`;
    logModal.show();

  } catch (e) {
    showAlert(`Erro ao abrir INI: ${e.message}`, 'danger');
  }
}

document.getElementById('btnClearLog').onclick = () => {
  logsEl.textContent = '';
  // Resetar contadores ao limpar o log
  logCounters = { ERROR: 0, WARN: 0, INFO: 0, TOTAL: 0 };
  allLines = [];
  updateCountersDisplay(); // Atualiza a exibição para zerado
};

// --- WEBAPPS MANAGEMENT ---

// Adiciona novo WebApp
document.getElementById('btnAddWebApp').onclick = async () => {
  const n = prompt('Nome do WebApp (ex: Protheus Homologação):');
  if (!n) return;
  const u = prompt('URL (ex: http://localhost:8080):');
  if (!u) return;

  const agents = await getAgents();
  if (!agents.length) return showAlert('Nenhum agente configurado.', 'warning');
  const agent = agents[0]; // por enquanto usa o primeiro

  try {
    const resp = await fetch(`${agent.url}/api/webapp/${n}`, {
      method: 'POST',
      headers: { 'x-api-key': agent.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: u }),
    });
    if (!resp.ok) throw new Error(await resp.text());
    showAlert(`WebApp "${n}" adicionado com sucesso.`, 'success');
    renderWebApps();
  } catch (err) {
    showAlert(`Erro ao adicionar WebApp: ${err.message}`, 'danger');
  }
};

// Renderiza WebApps
async function renderWebApps() {
  const listEl = document.getElementById('webappList');
  listEl.innerHTML = '<div class="text-muted">Atualizando WebApps...</div>';

  const agents = await getAgents();
  if (!agents.length) {
    listEl.innerHTML = '<div class="alert alert-warning">Nenhum agente configurado.</div>';
    return;
  }

  const agent = agents[0];

  try {
    // 1 - Obtém lista de webapps
    const appsResp = await fetch(`${agent.url}/api/webapps`, {
      headers: { 'x-api-key': agent.key },
    });
    if (!appsResp.ok) throw new Error(await appsResp.text());
    const apps = await appsResp.json();

    // 2 - Obtém status atual
    const statusResp = await fetch(`${agent.url}/api/webappstatus`, {
      headers: { 'x-api-key': agent.key },
    });
    const statusMap = await statusResp.json();

    listEl.innerHTML = '';

    const entries = Object.entries(apps);
    if (!entries.length) {
      listEl.innerHTML = '<div class="alert alert-secondary">Nenhum WebApp monitorado.</div>';
      return;
    }

    for (const [name, url] of entries) {
      const st = statusMap[name] || { ok: false, ms: null, lastCheck: null };
      const badge = st.ok
        ? `<span class="badge text-bg-success">Online - Tempo de Resposta : (${st.ms} ms)</span>`
        : `<span class="badge text-bg-danger">Offline</span>`;

      const lastCheckTime = st.lastCheck ? new Date(st.lastCheck).toLocaleTimeString() : '--:--:--';
      const nextCheckTime = st.lastCheck
        ? new Date(new Date(st.lastCheck).getTime() + 65000).toLocaleTimeString()
        : '--:--:--';

      const card = document.createElement('div');
      card.className = 'border-bottom py-2 d-flex justify-content-between align-items-center';

      card.innerHTML = `
        <div>
          <strong><i class="bi bi-globe2"></i> ${name}</strong> - ${badge}<br>
          <small class="text-muted">${url} <a href="${url}" target="_blank" class="text-decoration-none"><i class="bi bi-box-arrow-up-right"></i></a></small><br>
          <small class="text-muted">
            Última verificação: ${lastCheckTime} | Próxima em: ${nextCheckTime}
          </small>
        </div>
        <button class="btn btn-sm btn-danger" title="Excluir ${name}">
          <i class="bi bi-trash3-fill"></i>
        </button>
      `;

      const delBtn = card.querySelector('button');
      delBtn.addEventListener('click', async () => {
        if (!confirm(`Deseja realmente remover o WebApp "${name}"?`)) return;
        try {
          const delResp = await fetch(`${agent.url}/api/webapp/${name}`, {
            method: 'DELETE',
            headers: { 'x-api-key': agent.key },
          });
          if (!delResp.ok) throw new Error(await delResp.text());
          showAlert(`WebApp "${name}" removido com sucesso.`, 'success');
          renderWebApps();
        } catch (err) {
          showAlert(`Erro ao remover WebApp: ${err.message}`, 'danger');
        }
      });

      listEl.appendChild(card);
    }
  } catch (err) {
    listEl.innerHTML = `<div class="alert alert-danger">Erro ao carregar WebApps: ${err.message}</div>`;
  }
}

document.getElementById('btnRefreshAll').onclick = () => {
  renderWebApps();
  renderAgents();
};

// Atualiza periodicamente e executa na inicialização
setInterval(renderWebApps, 60000);
renderWebApps();
renderAgents();