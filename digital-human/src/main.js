import { loadConfig } from './config.js';
import { createMetaClient } from './meta.js';
import { createLanguageManager } from './language.js';
import { createBridge } from './bridge.js';
import { openStore } from './store.js';
import { createOrchestrator } from './orchestrator.js';
import { createServer } from './server.js';
import { createVoice } from './voice.js';

const config = loadConfig();
const meta = createMetaClient(config.meta);
const language = createLanguageManager({ meta, understandModel: config.meta.understandModel, replyModel: config.meta.replyModel });
const bridge = createBridge({ baseUrl: config.investigationUrl, cookieName: config.cookieName });
const store = openStore(config.dbPath);
const orchestrator = createOrchestrator({ bridge, language, store, languages: config.languages });

const voice = createVoice(config.voice);
const server = createServer({ config, bridge, orchestrator, metaEnabled: meta.enabled, voice, store });
server.listen(config.port, async () => {
  console.log(`[voice] FastPay Voice on http://localhost:${config.port}: used by the payment-help page (${config.helpUrl})`);
  console.log(`[voice] Languages: ${config.languages.join(', ')}`);
  console.log(`[voice] Meta: ${meta.enabled ? `on (understand ${config.meta.understandModel}, reply ${config.meta.replyModel})` : 'OFF: English rules only. Set META_API_KEY and META_BASE_URL.'}`);
  console.log(`[voice] Voice (YarnGPT): ${(await voice.check()).message}`);
  const health = await fetch(`${config.investigationUrl}/health`).then((r) => r.ok).catch(() => false);
  console.log(`[voice] Payment help (Module 2) at ${config.investigationUrl}: ${health ? 'connected' : 'NOT reachable. Start it with `npm start` in investigation/.'}`);
});
