import { Notice, Plugin, TAbstractFile, TFile, normalizePath } from 'obsidian';
import { R2Client, type R2Config } from './r2';
import {
  AxxaConnectSettingTab,
  DEFAULT_SETTINGS,
  normalizePrefix,
  type AxxaConnectSettings,
} from './settings';

export default class AxxaConnectPlugin extends Plugin {
  settings!: AxxaConnectSettings;
  private saveTimers = new Map<string, number>();

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new AxxaConnectSettingTab(this.app, this));

    this.addRibbonIcon('cloud', 'Axxa Connect: push all to R2', () => this.pushAll());

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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
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
      new Notice(`Axxa Connect: connection failed — ${(e as Error).message}`);
    }
  }

  async pushFile(file: TFile, silent = false) {
    const r2 = this.client();
    if (!r2) return;
    try {
      if (file.extension === 'md') {
        await r2.put(file.path, await this.app.vault.read(file));
      } else {
        await r2.put(file.path, await this.app.vault.readBinary(file));
      }
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
        if (file.extension === 'md') await r2.put(file.path, await this.app.vault.read(file));
        else await r2.put(file.path, await this.app.vault.readBinary(file));
      } catch {
        errors++;
      }
      done++;
      notice.setMessage(`Axxa Connect: pushing ${done}/${files.length}...`);
    }
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
        await this.ensureFolder(rel);
        if (rel.endsWith('.md')) {
          await this.app.vault.adapter.write(rel, await r2.getText(rel));
        } else {
          if (!this.settings.includeNonMarkdown) continue;
          await this.app.vault.adapter.writeBinary(rel, await r2.getBinary(rel));
        }
        done++;
        notice.setMessage(`Axxa Connect: pulling ${done}/${objects.length}...`);
      }
      notice.hide();
      new Notice(`Axxa Connect: ${done} file(s) updated from R2.`);
    } catch (e) {
      notice.hide();
      new Notice(`Axxa Connect: pull error — ${(e as Error).message}`);
    }
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
