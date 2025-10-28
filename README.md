# 🚀 Protheus Monitor Manager (Multi-Agent)
![GitHub repo size](https://img.shields.io/github/repo-size/LeonardoMarconi/Protheus_Monitor_Manager?style=for-the-badge)
![GitHub language count](https://img.shields.io/github/languages/count/LeonardoMarconi/Protheus_Monitor_Manager?style=for-the-badge)
![GitHub forks](https://img.shields.io/github/forks/LeonardoMarconi/Protheus_Monitor_Manager?style=for-the-badge)
![Bitbucket open issues](https://img.shields.io/bitbucket/issues/LeonardoMarconi/Protheus_Monitor_Manager?style=for-the-badge)
![Bitbucket open pull requests](https://img.shields.io/bitbucket/pr-raw/LeonardoMarconi/Protheus_Monitor_Manager?style=for-the-badge)

Este projeto consiste em um sistema de monitoramento para ambientes TOTVS Protheus, composto por duas partes principais: um **Agente Node.js** (backend) que roda no servidor e uma **Extensão Chrome** (frontend) que atua como interface de controle.

## 🌟 Funcionalidades

### Agente Node.js (`server.js`)
* ✅ **Controle de Serviços Windows:** Iniciar, parar e reiniciar serviços (filtrados por TOTVS, mas configurável).
* 💾 **Persistência de Configurações:** Salva o caminho dos arquivos de log e INI por serviço.
* 📡 **Streaming de Log em Tempo Real:** Utiliza WebSocket para monitorar e transmitir o log de um arquivo (por exemplo, `appserver.log`) linha por linha, permitindo visualização em tempo real.
* 🔍 **Leitura de INI:** Permite ler e exibir o conteúdo do arquivo `.ini` (ex: `appserver.ini`).
* 🌐 **Monitoramento de WebApps:** Verifica o status (Online/Offline e tempo de resposta) de URLs configuradas.
* 🔒 **Segurança Básica:** Autenticação via `x-api-key` para todas as rotas de controle.

### Extensão Chrome (`popup.js` / `popup.html`)
* 💻 **Interface Amigável:** Painel de controle responsivo (Bootstrap) com suporte a tema Claro/Escuro.
* 🔗 **Gerenciamento de Múltiplos Agentes:** Permite configurar e conectar-se a vários servidores (Agentes) distintos.
* 🔧 **Controle Direto:** Botões para Start/Stop/Restart de serviços diretamente da extensão.
* 📜 **Visualizador de Log:** Modal com streaming de log via WebSocket, filtro por tags (`[ERROR]`, `[WARN]`, `[INFO]`) e limite de linhas.
* ⚙️ **Visualizador de INI:** Exibe o conteúdo do arquivo de configuração (`.ini`) do serviço.
* 🚦 **Status de WebApps:** Painel dedicado para monitorar a saúde das URLs configuradas (ex: SmartClient Web, REST API).

---

## 🛠️ Como Instalar e Usar

A instalação é dividida em duas etapas: a configuração do Agente (servidor) e a instalação da Extensão (cliente).

### 1. Configuração do Agente Node.js (Servidor)

O Agente deve ser instalado no servidor Windows onde os serviços Protheus estão rodando.

#### Pré-requisitos
* **Node.js:** Versão LTS (v16.x ou superior).
* **Permissões:** O Node.js/Agente deve ter permissão para executar comandos do PowerShell e ler/escrever arquivos de log/configuração.

#### Instalação
1.  Crie uma pasta (ex: `protheus-agent`) no seu servidor.
2.  Coloque os arquivos `server.js`, `inis.json`, `logs.json` (vazios ou os arquivos iniciais) e `webapps.json` na pasta.
3.  Crie um arquivo `package.json` para gerenciar as dependências:
    ```json
    {
      "name": "protheus-monitor-agent",
      "version": "1.0.0",
      "description": "Protheus service and log monitor agent.",
      "main": "server.js",
      "scripts": {
        "start": "node server.js"
      },
      "dependencies": {
        "express": "^4.19.2",
        "cors": "^2.8.5",
        "ws": "^8.18.0",
        "chokidar": "^3.6.0",
        "axios": "^1.7.2"
      }
    }
    ```
4.  Abra o terminal nesta pasta e instale as dependências:
    ```bash
    npm install
    ```

#### Execução
1.  **Defina a Chave de API** (obrigatório para segurança):
    ```bash
    set AGENT_API_KEY=sua_chave_secreta_aqui
    # (Opcional) Defina a porta, default é 3000
    # set PORT=3000 
    ```
    > **Nota:** Se você não definir `AGENT_API_KEY`, o padrão será `1234`. **MUDE ISSO EM PRODUÇÃO.**
2.  Inicie o servidor:
    ```bash
    npm start
    ```
    O agente estará rodando em `http://localhost:3000` (ou na porta configurada).

### 2. Instalação da Extensão Chrome (Cliente)

#### Instalação
1.  Crie uma pasta (ex: `protheus-extensao`).
2.  Coloque os arquivos `popup.html`, `popup.js`, e inclua a pasta `js/` (com `bootstrap.bundle.min.js`) e a pasta `icons/` (com o ícone da extensão).
3.  Crie o arquivo de manifesto (`manifest.json` - não fornecido, mas necessário):
    ```json
    {
      "manifest_version": 3,
      "name": "Protheus Monitor Manager",
      "version": "1.0",
      "description": "Gerenciamento e monitoramento de serviços e logs Protheus.",
      "action": {
        "default_popup": "popup.html",
        "default_icon": "icons/48.png"
      },
      "permissions": [
        "storage",
        "windows"
      ],
      "host_permissions": [
        "http://*/",
        "https://*/"
      ]
    }
    ```
4.  Abra o Chrome e vá em `chrome://extensions/`.
5.  Ative o **Modo Desenvolvedor** (canto superior direito).
6.  Clique em **Carregar sem compactação** e selecione a pasta da extensão (`protheus-extensao`).

#### Utilização
1.  Clique no ícone da Extensão.
2.  Na seção **Servers**, clique em **+ Adicionar**.
3.  Informe:
    * **Nome:** Nome amigável do servidor (ex: `Servidor Homologação`).
    * **URL:** Endereço do Agente (ex: `http://servidor-homologacao:3000`).
    * **API Key:** A chave secreta (`sua_chave_secreta_aqui`) definida no Agente.
4.  Após adicionar, os serviços serão carregados, e você poderá:
    * **Controlar Serviços:** Usar Start/Stop/Restart.
    * **Ver Log:** Ao clicar pela primeira vez, será solicitado o caminho do log (`C:\Protheus\bin\appserver\appserver.log`). Esse caminho será salvo no Agente.
    * **Ver INI:** Ao clicar pela primeira vez, será solicitado o caminho do INI (`C:\Protheus\bin\appserver\appserver.ini`). Esse caminho será salvo no Agente.
5.  Na seção **WebApps**, use **+ Adicionar** para configurar URLs de monitoramento.

---

## 🛑 Notas de Segurança e Desempenho

* **API KEY:** A chave de API protege suas rotas de controle. Use uma chave longa e complexa e não a exponha publicamente.
* **WebSockets:** O streaming de log é feito via WebSocket. Certifique-se de que a porta do Agente está liberada no firewall do servidor e da rede.
* **chokidar/Polling:** O Agente usa a biblioteca `chokidar` com *polling* (intervalo de 1s) para monitorar o log. Em ambientes de altíssimo volume de IO, isso pode gerar alguma sobrecarga; ajuste o parâmetro `interval` no `server.js` se necessário.
* **Log Buffer:** A Extensão limita a exibição a **2000 linhas** para manter o desempenho do navegador.
