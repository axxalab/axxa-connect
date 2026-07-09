import { Notice, Plugin, TAbstractFile, TFile, normalizePath } from 'obsidian';
import { R2Client, type R2Config, type R2Object } from './r2';
import {
  AxxaConnectSettingTab,
  DEFAULT_SETTINGS,
  normalizePrefix,
  type AxxaConnectSettings,
} from './settings';

// Estado do último sync por arquivo. Permite detectar o que mudou de cada lado
// sem reler todo o conteúdo: mtime local + ETag remoto.
interface SyncEntry {
  localMtime: number;
  remoteEtag: string;
}
type SyncState = Record<string, SyncEntry>;

export default class AxxaConnectPlugin extends Plugin {
  settings!: AxxaConnectSettings;
  syncState: SyncState = {};
  private saveTimers = new Map<string, number>();
  private syncing = false;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new AxxaConnectSettingTab(this.app, this));

    // Botão principal na barra lateral: sincronização bidirecional.
    this.addRibbonIcon('refresh-cw', 'Axxa Connect: sync with R2', () => this.syncAll());

    this.addCommand({ id: 'sync-all', name: 'Sync vault with R2 (two-way)', callback: () => this.syncAll() });

    this.addCommand({
      id: 'push-current',
      name: 'Push current file to R2',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.pushFile(file);
        return true;
      },
    });

    this.addCommand({ id: 'push-all', name: 'Push entire vault to R2', callback: () => this.pushAll() });
    this.addCommand({ id: 'pull-all', name: 'Pull entire vault from R2 (overwrites local)', callback: () => this.pullAll() });
    this.addCommand({ id: 'test-connection', name: 'Test R2 connection', callback: () => this.testConnection() });

    // Optional automatic push on save, debounced per file.
    this.registerEvent(
      this.app.vault.on('modify', (file: TAbstractFile) => {
        if (!this.settings.syncOnSave || !(file instanceof TFile)) return;
        if (!this.shouldSync(file)) return;
        const prev = this.saveTimers.get(file.path);
        if (prev) window.clearTimeout(prev);
        const id = window.setTimeout(() => {
          this.saveTimers.delete(file.path);
          this.pushFile(file, true);
        }, 1500);
        this.saveTimers.set(file.path, id);
      }),
    );
  }

  onunload() {
    for (const id of this.saveTimers.values()) window.clearTimeout(id);
    this.saveTimers.clear();
  }

  async loadSettings() {
    const data = (await this.loadData()) as
      | { settings?: AxxaConnectSettings; syncState?: SyncState }
      | AxxaConnectSettings
      | null;
    // Compatível com o formato antigo (settings salvas na raiz do data.json).
    const rawSettings =
      data && typeof data === 'object' && 'settings' in (data as object)
        ? (data as { settings?: AxxaConnectSettings }).settings
        : (data as AxxaConnectSettings | null);
    this.settings = Object.assign({}, DEFAULT_SETTINGS, rawSettings ?? {});
    this.syncState =
      data && typeof data === 'object' && 'syncState' in (data as object)
        ? (data as { syncState?: SyncState }).syncState ?? {}
        : {};
  }

  private async persist() {
    await this.saveData({ settings: this.settings, syncState: this.syncState });
  }

  async saveSettings() {
    await this.persist();
  }

  private config(): R2Config | null {
    const s = this.settings;
    if (!s.accountId || !s.accessKeyId || !s.secretAccessKey || !s.bucket) {
      new Notice('Axxa Connect: fill in Account ID, keys and bucket in settings.');
      return null;
    }
    return {
      accountId: s.accountId,
      accessKeyId: s.accessKeyId,
      secretAccessKey: s.secretAccessKey,
      bucket: s.bucket,
      prefix: normalizePrefix(s.prefix),
      region: s.region || 'auto',
    };
  }

  private client(): R2Client | null {
    const cfg = this.config();
    return cfg ? new R2Client(cfg) : null;
  }

  private shouldSync(file: TFile): boolean {
    return this.settings.includeNonMarkdown || file.extension === 'md';
  }

  async testConnection() {
    const r2 = this.client();
    if (!r2) return;
    try {
      await r2.testConnection();
      new Notice('Axxa Connect: R2 connection OK ✓');
    } catch (e) {
      console.error('Axxa Connect: connection failed', e);
      new Notice(`Axxa Connect: connection failed — ${(e as Error).message}`);
    }
  }

  async pushFile(file: TFile, silent = false) {
    const r2 = this.client();
    if (!r2) return;
    try {
      await this.pushOne(r2, file);
      if (!silent) new Notice(`Axxa Connect: pushed ${file.path}`);
    } catch (e) {
      new Notice(`Axxa Connect: error pushing ${file.path} — ${(e as Error).message}`);
    }
  }

  async pushAll() {
    const r2 = this.client();
    if (!r2) return;
    const files = this.app.vault.getFiles().filter((f) => this.shouldSync(f));
    const notice = new Notice(`Axxa Connect: pushing 0/${files.length}...`, 0);
    let done = 0;
    let errors = 0;
    for (const file of files) {
      try {
        await this.pushOne(r2, file);
      } catch {
        errors++;
      }
      done++;
      notice.setMessage(`Axxa Connect: pushing ${done}/${files.length}...`);
    }
    await this.persist();
    notice.hide();
    new Notice(`Axxa Connect: push done (${done - errors}/${files.length}${errors ? `, ${errors} error(s)` : ''}).`);
  }

  async pullAll() {
    const r2 = this.client();
    if (!r2) return;
    const notice = new Notice('Axxa Connect: pulling from R2...', 0);
    try {
      const objects = await r2.list('');
      let done = 0;
      for (const obj of objects) {
        const rel = normalizePath(r2.stripPrefix(obj.key));
        if (!rel || rel.endsWith('/')) continue;
        if (!rel.endsWith('.md') && !this.settings.includeNonMarkdown) continue;
        await this.pullOne(r2, rel, obj);
        done++;
        notice.setMessage(`Axxa Connect: pulling ${done}/${objects.length}...`);
      }
      await this.persist();
      notice.hide();
      new Notice(`Axxa Connect: ${done} file(s) updated from R2.`);
    } catch (e) {
      notice.hide();
      new Notice(`Axxa Connect: pull error — ${(e as Error).message}`);
    }
  }

  // Sincronização bidirecional. Compara o estado atual dos dois lados com o
  // último sync registrado e move só o que mudou. Conflitos (mudou dos dois
  // lados) são resolvidos por "mais recente vence". Nada é apagado.
  async syncAll() {
    if (this.syncing) {
      new Notice('Axxa Connect: a sync is already running.');
      return;
    }
    const r2 = this.client();
    if (!r2) return;

    this.syncing = true;
    const notice = new Notice('Axxa Connect: syncing…', 0);
    let pushed = 0;
    let pulled = 0;
    let conflicts = 0;
    let errors = 0;
    try {
      const remoteObjs = await r2.list('');
      const remoteMap = new Map<string, R2Object>();
      for (const o of remoteObjs) {
        const rel = normalizePath(r2.stripPrefix(o.key));
        if (!rel || rel.endsWith('/')) continue;
        if (!rel.endsWith('.md') && !this.settings.includeNonMarkdown) continue;
        remoteMap.set(rel, o);
      }

      const localMap = new Map<string, TFile>();
      for (const f of this.app.vault.getFiles()) if (this.shouldSync(f)) localMap.set(f.path, f);

      const paths = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);
      for (const path of paths) {
        const local = localMap.get(path);
        const remote = remoteMap.get(path);
        const state = this.syncState[path];
        try {
          if (local && !remote) {
            // Só existe local: arquivo novo → envia.
            await this.pushOne(r2, local);
            pushed++;
          } else if (!local && remote) {
            // Só existe remoto: arquivo novo → baixa.
            await this.pullOne(r2, path, remote);
            pulled++;
          } else if (local && remote) {
            const localChanged = !state || local.stat.mtime !== state.localMtime;
            const remoteChanged = !state || remote.etag !== state.remoteEtag;
            if (localChanged && !remoteChanged) {
              await this.pushOne(r2, local);
              pushed++;
            } else if (remoteChanged && !localChanged) {
              await this.pullOne(r2, path, remote);
              pulled++;
            } else if (localChanged && remoteChanged) {
              conflicts++;
              if (local.stat.mtime >= remote.lastModified) {
                await this.pushOne(r2, local);
                pushed++;
              } else {
                await this.pullOne(r2, path, remote);
                pulled++;
              }
            }
            // else: nada mudou → mantém o estado como está.
          }
        } catch (e) {
          console.error(`Axxa Connect: sync error on ${path}`, e);
          errors++;
        }
        notice.setMessage(`Axxa Connect: syncing… ↑${pushed} ↓${pulled}`);
      }

      await this.persist();
      notice.hide();
      new Notice(
        `Axxa Connect: sync done — ↑${pushed} sent, ↓${pulled} received` +
          `${conflicts ? `, ${conflicts} conflict(s) kept newest` : ''}` +
          `${errors ? `, ${errors} error(s)` : ''}.`,
      );
    } catch (e) {
      console.error('Axxa Connect: sync failed', e);
      notice.hide();
      new Notice(`Axxa Connect: sync error — ${(e as Error).message}`);
    } finally {
      this.syncing = false;
    }
  }

  // Envia um arquivo e registra o estado (mtime local + ETag remoto).
  private async pushOne(r2: R2Client, file: TFile) {
    const body =
      file.extension === 'md'
        ? await this.app.vault.read(file)
        : await this.app.vault.readBinary(file);
    const etag = await r2.put(file.path, body);
    this.syncState[file.path] = { localMtime: file.stat.mtime, remoteEtag: etag };
  }

  // Baixa um objeto para o vault e registra o estado.
  private async pullOne(r2: R2Client, rel: string, remote: R2Object) {
    await this.ensureFolder(rel);
    if (rel.endsWith('.md')) {
      await this.app.vault.adapter.write(rel, await r2.getText(rel));
    } else {
      await this.app.vault.adapter.writeBinary(rel, await r2.getBinary(rel));
    }
    const st = await this.app.vault.adapter.stat(rel);
    this.syncState[rel] = { localMtime: st?.mtime ?? Date.now(), remoteEtag: remote.etag };
  }

  // Ensures the folders in the path exist before writing the file.
  private async ensureFolder(filePath: string) {
    const parts = filePath.split('/');
    parts.pop();
    let dir = '';
    for (const part of parts) {
      dir = dir ? `${dir}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(dir))) {
        await this.app.vault.adapter.mkdir(dir);
      }
    }
  }
}
