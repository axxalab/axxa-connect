import { App, PluginSettingTab, Setting } from 'obsidian';
import type AxxaConnectPlugin from './main';

export interface AxxaConnectSettings {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  prefix: string;
  region: string;
  syncOnSave: boolean;
  includeNonMarkdown: boolean;
}

export const DEFAULT_SETTINGS: AxxaConnectSettings = {
  accountId: '',
  accessKeyId: '',
  secretAccessKey: '',
  bucket: '',
  prefix: '',
  region: 'auto',
  syncOnSave: false,
  includeNonMarkdown: false,
};

// Normalizes the prefix: no leading slash, trailing slash when non-empty.
export function normalizePrefix(prefix: string): string {
  let p = (prefix || '').trim().replace(/^\/+/, '');
  if (p && !p.endsWith('/')) p += '/';
  return p;
}

export class AxxaConnectSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: AxxaConnectPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Axxa Connect — Cloudflare R2' });
    containerEl.createEl('p', {
      text: 'Files are stored as plain text (no encryption), so they stay readable by other tools and AIs. Do not enable an encryption password on any other sync plugin pointing at the same bucket.',
    });

    const save = async () => await this.plugin.saveSettings();

    new Setting(containerEl)
      .setName('Account ID')
      .setDesc('Your Cloudflare account ID (part of the R2 endpoint).')
      .addText((t) =>
        t.setPlaceholder('e.g. 1a2b3c...').setValue(this.plugin.settings.accountId).onChange(async (v) => {
          this.plugin.settings.accountId = v.trim();
          await save();
        }),
      );

    new Setting(containerEl)
      .setName('Access Key ID')
      .addText((t) =>
        t.setValue(this.plugin.settings.accessKeyId).onChange(async (v) => {
          this.plugin.settings.accessKeyId = v.trim();
          await save();
        }),
      );

    new Setting(containerEl)
      .setName('Secret Access Key')
      .addText((t) => {
        t.setValue(this.plugin.settings.secretAccessKey).onChange(async (v) => {
          this.plugin.settings.secretAccessKey = v.trim();
          await save();
        });
        t.inputEl.type = 'password';
      });

    new Setting(containerEl)
      .setName('Bucket')
      .setDesc('The R2 bucket name that stores your vault.')
      .addText((t) =>
        t.setValue(this.plugin.settings.bucket).onChange(async (v) => {
          this.plugin.settings.bucket = v.trim();
          await save();
        }),
      );

    new Setting(containerEl)
      .setName('Prefix (optional)')
      .setDesc('Subfolder inside the bucket where the vault lives. Empty = bucket root.')
      .addText((t) =>
        t.setPlaceholder('e.g. vault/').setValue(this.plugin.settings.prefix).onChange(async (v) => {
          this.plugin.settings.prefix = v;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName('Include non-markdown files')
      .setDesc('Also sync images, PDFs and other attachments (besides .md files).')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.includeNonMarkdown).onChange(async (v) => {
          this.plugin.settings.includeNonMarkdown = v;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName('Push on save')
      .setDesc('Automatically upload each file to R2 when it is modified (debounced).')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncOnSave).onChange(async (v) => {
          this.plugin.settings.syncOnSave = v;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName('Test connection')
      .addButton((b) =>
        b.setButtonText('Test').setCta().onClick(async () => {
          await this.plugin.testConnection();
        }),
      );
  }
}
