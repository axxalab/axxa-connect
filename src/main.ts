import { Notice, Plugin, TAbstractFile, TFile, TFolder, normalizePath } from 'obsidian';
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

// Operação decidida na fase de comparação, executada em paralelo depois.
type SyncOp =
  | { kind: 'push'; path: string; file: TFile }
  | { kind: 'pull'; path: string; remote: R2Object }
  | { kind: 'delRemote'; path: string; remote: R2Object }
  | { kind: 'delLocal'; path: string; file: TFile };

export default class AxxaConnectPlugin extends Plugin {
  settings!: AxxaConnectSettings;
  syncState: SyncState = {};
  // Lápides: caminhos apagados/movidos localmente enquanto o plugin rodava.
  // Capturamos o evento de exclusão na hora, para o próximo sync ter CERTEZA de
  // que foi você que apagou (e propagar a exclusão pro R2) em vez de restaurar.
  // Caminhos de PASTA terminam em '/' e valem como prefixo. Persistido.
  private pendingDeletes: string[] = [];
  // True enquanto o sync está escrevendo/apagando no vault, para ignorarmos os
  // eventos que a nossa própria operação dispara (senão viraria lápide/re-push).
  private applyingRemote = false;
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
        if (this.applyingRemote) return; // mudança causada pelo próprio pull
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

    // Exclusão local → registra lápide para propagar a remoção no próximo sync.
    this.registerEvent(
      this.app.vault.on('delete', (file: TAbstractFile) => {
        if (this.applyingRemote) return; // remoção feita pelo próprio sync
        if (file instanceof TFolder) this.recordDeletion(file.path + '/');
        else if (this.shouldSyncPath(file.path)) this.recordDeletion(file.path);
      }),
    );

    // Rename/movimentação → o caminho ANTIGO deve ser removido no R2; o novo
    // caminho é enviado normalmente (aparece como arquivo local novo/alterado).
    this.registerEvent(
      this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
        if (this.applyingRemote) return;
        if (file instanceof TFolder) this.recordDeletion(oldPath + '/');
        else if (this.shouldSyncPath(oldPath)) this.recordDeletion(oldPath);
      }),
    );
  }

  onunload() {
    for (const id of this.saveTimers.values()) window.clearTimeout(id);
    this.saveTimers.clear();
  }

  async loadSettings() {
    const data = (await this.loadData()) as
      | { settings?: AxxaConnectSettings; syncState?: SyncState; pendingDeletes?: string[] }
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
    this.pendingDeletes =
      data && typeof data === 'object' && 'pendingDeletes' in (data as object)
        ? (data as { pendingDeletes?: string[] }).pendingDeletes ?? []
        : [];
  }

  private async persist() {
    await this.saveData({
      settings: this.settings,
      syncState: this.syncState,
      pendingDeletes: this.pendingDeletes,
    });
  }

  async saveSettings() {
    await this.persist();
  }

  private shouldSyncPath(path: string): boolean {
    return this.settings.includeNonMarkdown || path.endsWith('.md');
  }

  // Registra uma lápide (exclusão/movimentação local) e persiste na hora, para
  // sobreviver a um reload até o próximo sync propagar a remoção.
  private recordDeletion(path: string) {
    if (!this.pendingDeletes.includes(path)) {
      this.pendingDeletes.push(path);
      void this.persist();
    }
  }

  // Um caminho remoto casa com uma lápide se for igual a ela, ou se estiver
  // dentro de uma lápide de pasta (que termina em '/').
  private isTombstoned(path: string, tombstones: Set<string>): boolean {
    if (tombstones.has(path)) return true;
    for (const t of tombstones) if (t.endsWith('/') && path.startsWith(t)) return true;
    return false;
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
    this.applyingRemote = true;
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
    } finally {
      this.applyingRemote = false;
    }
  }

  // Sincronização bidirecional com propagação de movimentações/exclusões.
  // Comparação de três vias: estado ATUAL local × remoto × ESTADO do último
  // sync. Isso permite distinguir "arquivo novo" de "arquivo apagado/movido":
  // uma movimentação = apagar no caminho antigo + criar no novo, e ambos os
  // lados convergem para o mesmo caminho (sem cópias duplicadas). As operações
  // rodam em paralelo (rápido) e só transfere o que mudou (incremental).
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
    let removed = 0;
    let conflicts = 0;
    let errors = 0;
    try {
      // 1) Snapshot dos dois lados: uma listagem remota + varredura local.
      const remoteMap = new Map<string, R2Object>();
      for (const o of await r2.list('')) {
        const rel = normalizePath(r2.stripPrefix(o.key));
        if (!rel || rel.endsWith('/')) continue;
        if (!rel.endsWith('.md') && !this.settings.includeNonMarkdown) continue;
        remoteMap.set(rel, o);
      }
      const localMap = new Map<string, TFile>();
      for (const f of this.app.vault.getFiles()) if (this.shouldSync(f)) localMap.set(f.path, f);

      // 2) Decide a operação de cada caminho.
      const propagate = this.settings.propagateDeletes;
      const tombstones = new Set(this.pendingDeletes);
      const ops: SyncOp[] = [];
      const paths = new Set<string>([
        ...localMap.keys(),
        ...remoteMap.keys(),
        ...Object.keys(this.syncState),
      ]);
      for (const path of paths) {
        const local = localMap.get(path);
        const remote = remoteMap.get(path);
        const state = this.syncState[path];
        const localChanged = local ? !state || local.stat.mtime !== state.localMtime : false;
        const remoteChanged = remote ? !state || remote.etag !== state.remoteEtag : false;

        if (local && remote) {
          if (localChanged && remoteChanged) {
            conflicts++;
            ops.push(
              local.stat.mtime >= remote.lastModified
                ? { kind: 'push', path, file: local }
                : { kind: 'pull', path, remote },
            );
          } else if (localChanged) {
            ops.push({ kind: 'push', path, file: local });
          } else if (remoteChanged) {
            ops.push({ kind: 'pull', path, remote });
          } else if (!state) {
            // Idênticos e sem estado (primeiro sync) → só registra a baseline.
            this.syncState[path] = { localMtime: local.stat.mtime, remoteEtag: remote.etag };
          }
        } else if (local && !remote) {
          if (state && propagate && !localChanged) {
            // Existia remotamente e sumiu → foi apagado/movido no outro lado.
            ops.push({ kind: 'delLocal', path, file: local });
          } else if (state && propagate && localChanged) {
            // Conflito apagar-vs-editar → preserva o local (re-envia).
            conflicts++;
            ops.push({ kind: 'push', path, file: local });
          } else {
            // Arquivo novo local (ou propagação desligada) → envia.
            ops.push({ kind: 'push', path, file: local });
          }
        } else if (!local && remote) {
          if (propagate && this.isTombstoned(path, tombstones)) {
            // CERTEZA de que foi apagado/movido localmente (evento capturado) →
            // apaga no R2, mesmo sem estado base. É isto que faz o delete
            // funcionar de primeira em vez de restaurar.
            ops.push({ kind: 'delRemote', path, remote });
          } else if (state && propagate && !remoteChanged) {
            // Existia localmente e sumiu → foi apagado/movido aqui → apaga remoto.
            ops.push({ kind: 'delRemote', path, remote });
          } else if (state && propagate && remoteChanged) {
            // Conflito apagar-vs-editar → preserva o remoto (baixa).
            conflicts++;
            ops.push({ kind: 'pull', path, remote });
          } else {
            // Arquivo novo remoto (ou propagação desligada) → baixa.
            ops.push({ kind: 'pull', path, remote });
          }
        } else {
          // Não existe em lugar nenhum, só no estado → limpa.
          delete this.syncState[path];
        }
      }

      // 3) Executa em paralelo com limite de concorrência. Marca applyingRemote
      // para ignorar os eventos disparados pelas nossas próprias escritas/remoções.
      let done = 0;
      this.applyingRemote = true;
      try {
        await this.runPool(ops, 6, async (op) => {
          try {
            if (op.kind === 'push') {
              await this.pushOne(r2, op.file);
              pushed++;
            } else if (op.kind === 'pull') {
              await this.pullOne(r2, op.path, op.remote);
              pulled++;
            } else if (op.kind === 'delRemote') {
              await r2.del(op.path);
              delete this.syncState[op.path];
              removed++;
            } else if (op.kind === 'delLocal') {
              await this.trashLocal(op.path);
              delete this.syncState[op.path];
              removed++;
            }
          } catch (e) {
            console.error(`Axxa Connect: sync op failed (${op.kind} ${op.path})`, e);
            errors++;
          } finally {
            notice.setMessage(`Axxa Connect: syncing… ${++done}/${ops.length}`);
          }
        });
      } finally {
        this.applyingRemote = false;
      }

      // Lápides processadas neste sync. Se algum delRemote falhou, o estado
      // continua servindo de backstop (arquivo em estado + ausente local →
      // delRemote de novo no próximo sync).
      this.pendingDeletes = [];

      await this.persist();
      notice.hide();
      new Notice(
        `Axxa Connect: sync done — ↑${pushed} ↓${pulled}` +
          `${removed ? `, 🗑${removed}` : ''}` +
          `${conflicts ? `, ${conflicts} conflict(s)` : ''}` +
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

  // Roda `worker` sobre os itens com no máximo `limit` operações simultâneas.
  private async runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
    let i = 0;
    const next = async (): Promise<void> => {
      while (i < items.length) await worker(items[i++]);
    };
    const runners: Promise<void>[] = [];
    for (let k = 0; k < Math.min(limit, items.length); k++) runners.push(next());
    await Promise.all(runners);
  }

  // Move um arquivo local para a lixeira do vault (recuperável, funciona no
  // mobile). Cai para remoção direta se o arquivo não for um TAbstractFile.
  private async trashLocal(path: string) {
    const af = this.app.vault.getAbstractFileByPath(path);
    if (af) await this.app.vault.trash(af, false);
    else if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
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
