import { loadConfig } from './config.js';
import { createFastPayApi } from './fastpay/api.js';
import { openStore } from './store.js';
import { createMetaClient } from './llm.js';
import { createCaseService } from './cases.js';
import { createServer } from './server.js';
import { createAgent, createFastPayExecutor, createResolutionService, openStore as openResolutionStore } from '../../resolution/src/index.js';

const config = loadConfig();
const api = createFastPayApi({ baseUrl: config.fastpay.apiUrl, token: config.fastpay.token });
const store = openStore(config.dbPath);
const llm = createMetaClient(config.meta);
// Module 3: decision and resolution. Reads this module's reports; keeps its own database.
const resolutionStore = openResolutionStore(config.resolution.dbPath);
const agent = createAgent({ apiKey: config.meta.apiKey, baseUrl: config.meta.baseUrl, model: config.resolution.model });
// Real money: FastPay's resolution window posts the ledger legs / PayPal refunds after its own checks.
const executor = createFastPayExecutor({ baseUrl: config.fastpay.apiUrl, token: config.fastpay.resolutionToken });
const resolution = createResolutionService({
  store: resolutionStore,
  executor,
  agent,
  settings: config.resolution,
  cases: {
    latestReport: (caseId) => store.latestReport(caseId),
    messages: (caseId) => store.messages(caseId),
    say: (caseId, text) => text && store.addMessage(caseId, 'support', text),
  },
});
const service = createCaseService({ llm, store, config, resolution });

createServer({ service, api, config, llm, resolution }).listen(config.port, async () => {
  const log = (m) => console.log(`[investigation] ${m}`);
  log(`FastPay Investigation on http://localhost:${config.port}`);
  const link = await api.check();
  log(`FastPay investigation window (${config.fastpay.apiUrl}): ${link.ok ? 'connected, read-only' : `NOT connected: ${link.reason}`}`);
  log('Database / PayPal keys: none here. FastPay answers, for the signed-in customer only.');
  log(`Understanding: ${llm.enabled ? `Meta model ${config.meta.model}` : 'built-in English rules (set META_API_KEY, META_BASE_URL, META_MODEL to use Meta)'}`);
  log(`Resolution (Module 3): ${executor.enabled ? "REAL actions through FastPay's resolution window" : 'money actions OFF (set FASTPAY_RESOLUTION_TOKEN = RESOLUTION_API_TOKEN in server/.env)'}; agent ${agent.enabled ? `Meta ${agent.model}` : 'off, built-in rules'}`);
  log(`Internal report API: ${config.internalToken ? 'on (/internal/...)' : 'off (set INTERNAL_API_TOKEN to turn it on)'}`);
  log(`Sign in to FastPay at ${config.fastpay.appUrl}, then open http://localhost:${config.port}`);
});
