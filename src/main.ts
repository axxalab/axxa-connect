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
  | { kind: 'conflict'; path: string; file: TFile; remote: R2Object }
  | { kind: 'delRemote'; path: string; remote: R2Object }
  | { kind: 'delLocal'; path: string; file: TFile };

// Caminho interno usado só para o teste de permissão de escrita; nunca sincroniza.
const INTERNAL_PREFIX = '.axxa-connect/';
const CONCURRENCY = 6;

export default class AxxaConnectPlugin extends Plugin {
  settings!: AxxaConnectSettings;
  syncState: SyncState = {};
  // Lápides: caminhos apagados/movidos localmente enquanto o plugin rodava.
  // Capturamos o evento na hora, para o próximo sync ter CERTEZA de que foi
  // você que apagou (e propagar a remoção) em vez de restaurar. Pastas terminam
  // em '/' e valem como prefixo. Persistido no data.json.
  private pendingDeletes: string[] = [];
  // True enquanto o sync escreve/apaga no vault, para ignorarmos os eventos que
  // a nossa própria operação dispara (senão viraria lápide/re-push falso).
  private applyingRemote = false;
  private saveTimers = new Map<string, number>();
  private autoSyncTimer: number | null = null;
  private syncing = false;
  private lastSyncAt = 0;
  private lastSyncError = false;
  private statusBar: HTMLElement | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new AxxaConnectSettingTab(this.app, this));

    // Botão principal na barra lateral: sincronização bidirecional.
    this.addRibbonIcon('refresh-cw', 'Axxa Connect: sync with R2', () => this.syncAll());

    // Indicador na barra de status (clicável → sincroniza).
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass('mod-clickable');
    this.statusBar.onClickEvent(() => this.syncAll());
    this.updateStatus();

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

    // Eventos locais → push on save (arquivo único) e agendamento do auto-sync.
    this.registerEvent(this.app.vault.on('modify', (f) => this.onLocalChange('modify', f)));
    this.registerEvent(this.app.vault.on('create', (f) => this.onLocalChange('create', f)));
    this.registerEvent(this.app.vault.on('delete', (f) => this.onLocalDelete(f)));
    this.registerEvent(this.app.vault.on('rename', (f, oldPath) => this.onLocalRename(f, oldPath)));

    // Tick de 1 min: atualiza o "há Xm" da status bar e dispara o auto-sync por intervalo.
    this.registerInterval(window.setInterval(() => this.tick(), 60_000));

    // Sync no startup (após o layout carregar, com uma folga).
    if (this.settings.syncOnStartup) {
      this.app.workspace.onLayoutReady(() => window.setTimeout(() => this.syncAll(true), 3000));
    }
  }

  onunload() {
    for (const id of this.saveTimers.values()) window.clearTimeout(id);
    this.saveTimers.clear();
    if (this.autoSyncTimer) window.clearTimeout(this.autoSyncTimer);
  }

  // ---------------------------------------------------------------- settings

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

  // ------------------------------------------------------------- local events

  private onLocalChange(kind: 'modify' | 'create', file: TAbstractFile) {
    if (this.applyingRemote) return;
    if (kind === 'modify' && this.settings.syncOnSave && file instanceof TFile && this.shouldSync(file)) {
      const prev = this.saveTimers.get(file.path);
      if (prev) window.clearTimeout(prev);
      const id = window.setTimeout(() => {
        this.saveTimers.delete(file.path);
        this.pushFile(file, true);
      }, 1500);
      this.saveTimers.set(file.path, id);
    }
    if (file instanceof TFile && this.shouldSync(file)) this.scheduleAutoSync();
  }

  private onLocalDelete(file: TAbstractFile) {
    if (this.applyingRemote) return;
    let recorded = false;
    if (file instanceof TFolder) {
      this.recordDeletion(file.path + '/');
      recorded = true;
    } else if (this.shouldSyncPath(file.path)) {
      this.recordDeletion(file.path);
      recorded = true;
    }
    if (recorded) this.scheduleAutoSync();
  }

  private onLocalRename(file: TAbstractFile, oldPath: string) {
    if (this.applyingRemote) return;
    // O caminho ANTIGO deve ser removido no R2; o novo é enviado como arquivo novo.
    if (file instanceof TFolder) this.recordDeletion(oldPath + '/');
    else if (this.shouldSyncPath(oldPath)) this.recordDeletion(oldPath);
    this.scheduleAutoSync();
  }

  // Registra uma lápide e persiste na hora, para sobreviver a um reload.
  private recordDeletion(path: string) {
    if (!this.pendingDeletes.includes(path)) {
      this.pendingDeletes.push(path);
      void this.persist();
    }
  }

  private scheduleAutoSync(delay = 8000) {
    if (!this.settings.autoSync) return;
    if (this.autoSyncTimer) window.clearTimeout(this.autoSyncTimer);
    this.autoSyncTimer = window.setTimeout(() => {
      this.autoSyncTimer = null;
      this.syncAll(true);
    }, delay);
  }

  private tick() {
    this.updateStatus();
    if (!this.settings.autoSync || this.syncing || !this.hasConfig()) return;
    const intervalMs = Math.max(1, this.settings.autoSyncInterval) * 60_000;
    if (this.lastSyncAt === 0 || Date.now() - this.lastSyncAt >= intervalMs) this.syncAll(true);
  }

  // --------------------------------------------------------------- status bar

  private updateStatus() {
    if (!this.statusBar) return;
    let text: string;
    let title: string;
    if (this.syncing) {
      text = '⟳ Axxa';
      title = 'Axxa Connect: syncing…';
    } else if (this.lastSyncError) {
      text = '⚠ Axxa';
      title = 'Axxa Connect: last sync had errors — click to retry';
    } else if (this.lastSyncAt) {
      text = `☁ Axxa · ${this.relTime(this.lastSyncAt)}`;
      title = 'Axxa Connect: last synced — click to sync now';
    } else {
      text = '☁ Axxa';
      title = 'Axxa Connect: click to sync';
    }
    this.statusBar.setText(text);
    this.statusBar.title = title;
  }

  private relTime(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  }

  // ------------------------------------------------------------------- config

  private hasConfig(): boolean {
    const s = this.settings;
    return !!(s.accountId && s.accessKeyId && s.secretAccessKey && s.bucket);
  }

  private config(): R2Config | null {
    const s = this.settings;
    if (!this.hasConfig()) {
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
    return this.shouldSyncPath(file.path);
  }

  private shouldSyncPath(path: string): boolean {
    if (path.startsWith(INTERNAL_PREFIX)) return false;
    return this.settings.includeNonMarkdown || path.endsWith('.md');
  }

  // Um caminho remoto casa com uma lápide se for igual, ou se estiver dentro de
  // uma lápide de pasta (que termina em '/').
  private isTombstoned(path: string, tombstones: Set<string>): boolean {
    if (tombstones.has(path)) return true;
    for (const t of tombstones) if (t.endsWith('/') && path.startsWith(t)) return true;
    return false;
  }

  // ---------------------------------------------------------- connection test

  async testConnection() {
    const r2 = this.client();
    if (!r2) return;
    try {
      await r2.testConnection(); // list → leitura OK
    } catch (e) {
      console.error('Axxa Connect: connection failed', e);
      new Notice(`Axxa Connect: connection failed — ${(e as Error).message}`, 12000);
      return;
    }
    // Sonda de escrita: sobe um objeto minúsculo e apaga em seguida.
    const probe = `${INTERNAL_PREFIX}permcheck-${Date.now()}.txt`;
    try {
      await r2.put(probe, 'axxa-connect write test');
      try {
        await r2.del(probe);
      } catch {
        /* limpeza best-effort */
      }
      new Notice('Axxa Connect: connection OK ✓ (read & write).');
    } catch (e) {
      const msg = (e as Error).message;
      if (/->\s*40[13]/.test(msg)) {
        new Notice(
          'Axxa Connect: read OK, but WRITE is denied — this token is read-only. ' +
            'Sync can download but not upload or delete. Use an "Object Read & Write" R2 token.',
          15000,
        );
      } else {
        new Notice(`Axxa Connect: read OK, write failed — ${msg}`, 15000);
      }
    }
  }

  // ------------------------------------------------------------- manual push/pull

  async pushFile(file: TFile, silent = false) {
    const r2 = this.client();
    if (!r2) return;
    try {
      await this.pushOne(r2, file);
      await this.persist();
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
    await this.runPool(files, CONCURRENCY, async (file) => {
      try {
        await this.withRetry(() => this.pushOne(r2, file));
      } catch {
        errors++;
      }
      notice.setMessage(`Axxa Connect: pushing ${++done}/${files.length}...`);
    });
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
      const objects = (await r2.list('')).filter((o) => {
        const rel = normalizePath(r2.stripPrefix(o.key));
        return rel && !rel.endsWith('/') && this.shouldSyncPath(rel);
      });
      let done = 0;
      await this.runPool(objects, CONCURRENCY, async (obj) => {
        const rel = normalizePath(r2.stripPrefix(obj.key));
        try {
          await this.withRetry(() => this.pullOne(r2, rel, obj));
        } catch (e) {
          console.error(`Axxa Connect: pull failed ${rel}`, e);
        }
        notice.setMessage(`Axxa Connect: pulling ${++done}/${objects.length}...`);
      });
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

  // ------------------------------------------------------------- two-way sync

  // Sincronização bidirecional com propagação de movimentações/exclusões e
  // preservação em conflito. Comparação de três vias: estado ATUAL local ×
  // remoto × ESTADO do último sync (+ lápides de eventos capturados ao vivo).
  // As operações rodam em paralelo, com retry, e só transfere o que mudou.
  async syncAll(auto = false) {
    if (this.syncing) {
      if (!auto) new Notice('Axxa Connect: a sync is already running.');
      else this.scheduleAutoSync(15000); // tenta de novo depois
      return;
    }
    if (!this.hasConfig()) {
      if (!auto) new Notice('Axxa Connect: fill in Account ID, keys and bucket in settings.');
      return;
    }
    const r2 = this.client();
    if (!r2) return;

    this.syncing = true;
    this.lastSyncError = false;
    this.updateStatus();
    const notice = auto ? null : new Notice('Axxa Connect: syncing…', 0);
    let pushed = 0;
    let pulled = 0;
    let removed = 0;
    let conflicts = 0;
    let errors = 0;
    let firstError = '';
    try {
      // 1) Snapshot dos dois lados: uma listagem remota + varredura local.
      const remoteMap = new Map<string, R2Object>();
      for (const o of await r2.list('')) {
        const rel = normalizePath(r2.stripPrefix(o.key));
        if (!rel || rel.endsWith('/')) continue;
        if (!this.shouldSyncPath(rel)) continue;
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
            // Mudou dos dois lados → conflito.
            if (this.settings.conflictCopies) ops.push({ kind: 'conflict', path, file: local, remote });
            else if (local.stat.mtime >= remote.lastModified) ops.push({ kind: 'push', path, file: local });
            else ops.push({ kind: 'pull', path, remote });
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
          } else {
            // Novo local; ou apagou-remoto-vs-editou-local (preserva o local); ou
            // propagação desligada → sempre envia (nunca apaga o local editado).
            ops.push({ kind: 'push', path, file: local });
          }
        } else if (!local && remote) {
          if (propagate && this.isTombstoned(path, tombstones)) {
            // CERTEZA de exclusão/movimentação local (evento capturado ao vivo) →
            // apaga no R2 mesmo sem estado base. É isto que faz o delete funcionar
            // de primeira em vez de restaurar.
            ops.push({ kind: 'delRemote', path, remote });
          } else if (state && propagate && !remoteChanged) {
            // Existia localmente e sumiu → foi apagado/movido aqui → apaga remoto.
            ops.push({ kind: 'delRemote', path, remote });
          } else {
            // Novo remoto; ou apagou-local-vs-editou-remoto (preserva o remoto); ou
            // propagação desligada → sempre baixa.
            ops.push({ kind: 'pull', path, remote });
          }
        } else {
          // Não existe em lugar nenhum, só no estado → limpa.
          delete this.syncState[path];
        }
      }

      // 3) Executa em paralelo com retry. applyingRemote silencia os eventos
      // disparados pelas nossas próprias escritas/remoções.
      let done = 0;
      this.applyingRemote = true;
      try {
        await this.runPool(ops, CONCURRENCY, async (op) => {
          try {
            if (op.kind === 'push') {
              await this.withRetry(() => this.pushOne(r2, op.file));
              pushed++;
            } else if (op.kind === 'pull') {
              await this.withRetry(() => this.pullOne(r2, op.path, op.remote));
              pulled++;
            } else if (op.kind === 'conflict') {
              await this.resolveConflict(r2, op.path, op.file, op.remote);
              conflicts++;
            } else if (op.kind === 'delRemote') {
              await this.withRetry(() => r2.del(op.path));
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
            if (!firstError) firstError = (e as Error).message;
          } finally {
            if (notice) notice.setMessage(`Axxa Connect: syncing… ${++done}/${ops.length}`);
          }
        });
      } finally {
        this.applyingRemote = false;
      }

      // Lápides processadas. Se algum delRemote falhou, o estado continua de
      // backstop (arquivo em estado + ausente local → delRemote no próximo sync).
      this.pendingDeletes = [];

      await this.persist();
      this.lastSyncAt = Date.now();
      this.lastSyncError = errors > 0;
      if (notice) notice.hide();

      const changed = pushed + pulled + removed + conflicts;
      if (!auto || changed || errors) {
        new Notice(
          `Axxa Connect: sync done — ↑${pushed} ↓${pulled}` +
            `${removed ? `, 🗑${removed}` : ''}` +
            `${conflicts ? `, ${conflicts} conflict(s) kept both` : ''}` +
            `${errors ? `, ${errors} error(s) — ${firstError}` : ''}.`,
          errors ? 15000 : undefined,
        );
      }
    } catch (e) {
      console.error('Axxa Connect: sync failed', e);
      this.lastSyncError = true;
      if (notice) notice.hide();
      new Notice(`Axxa Connect: sync error — ${(e as Error).message}`, 12000);
    } finally {
      this.syncing = false;
      this.updateStatus();
    }
  }

  // Conflito real (mudou dos dois lados): mantém a versão mais nova no caminho
  // original e salva a mais antiga como cópia "(conflict …)". Nada se perde.
  private async resolveConflict(r2: R2Client, path: string, local: TFile, remote: R2Object) {
    const localNewer = local.stat.mtime >= remote.lastModified;
    const cpath = this.conflictPath(path);
    const isMd = path.endsWith('.md');
    if (localNewer) {
      // Vencedor = local. Salva o REMOTO (perdedor) como cópia de conflito.
      const loser = isMd ? await r2.getText(path) : await r2.getBinary(path);
      await this.ensureFolder(cpath);
      if (isMd) await this.app.vault.adapter.write(cpath, loser as string);
      else await this.app.vault.adapter.writeBinary(cpath, loser as ArrayBuffer);
      await this.withRetry(() => this.pushOne(r2, local));
      await this.withRetry(() => this.pushRaw(r2, cpath, loser));
    } else {
      // Vencedor = remoto. Salva o LOCAL (perdedor) como cópia e baixa o remoto.
      const loser = isMd ? await this.app.vault.read(local) : await this.app.vault.readBinary(local);
      await this.ensureFolder(cpath);
      if (isMd) await this.app.vault.adapter.write(cpath, loser as string);
      else await this.app.vault.adapter.writeBinary(cpath, loser as ArrayBuffer);
      await this.withRetry(() => this.pushRaw(r2, cpath, loser));
      await this.withRetry(() => this.pullOne(r2, path, remote));
    }
  }

  private conflictPath(path: string): string {
    const slash = path.lastIndexOf('/');
    const dot = path.lastIndexOf('.');
    const hasExt = dot > slash;
    const base = hasExt ? path.slice(0, dot) : path;
    const ext = hasExt ? path.slice(dot) : '';
    return `${base} (conflict ${this.timestampLabel()})${ext}`;
  }

  private timestampLabel(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  }

  // ----------------------------------------------------------------- helpers

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

  // Repete a operação em falhas transitórias (rede/5xx/429), com backoff.
  // NÃO repete em 4xx de permissão/entrada (403/404/400…), que não melhoram.
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        const status = Number(((e as Error).message || '').match(/->\s*(\d{3})/)?.[1] ?? 0);
        if (status >= 400 && status < 500 && status !== 429) break;
        if (attempt < 2) await this.sleep(300 * Math.pow(3, attempt)); // 300ms, 900ms
      }
    }
    throw lastErr;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => window.setTimeout(r, ms));
  }

  // Move um arquivo local para a lixeira do vault (recuperável, funciona no mobile).
  private async trashLocal(path: string) {
    const af = this.app.vault.getAbstractFileByPath(path);
    if (af) await this.app.vault.trash(af, false);
    else if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
  }

  // Envia um arquivo do vault e registra o estado (mtime local + ETag remoto).
  private async pushOne(r2: R2Client, file: TFile) {
    const body =
      file.extension === 'md'
        ? await this.app.vault.read(file)
        : await this.app.vault.readBinary(file);
    const etag = await r2.put(file.path, body);
    this.syncState[file.path] = { localMtime: file.stat.mtime, remoteEtag: etag };
  }

  // Envia um conteúdo já em memória (usado pelas cópias de conflito).
  private async pushRaw(r2: R2Client, path: string, body: string | ArrayBuffer) {
    const etag = await r2.put(path, body);
    const st = await this.app.vault.adapter.stat(path);
    this.syncState[path] = { localMtime: st?.mtime ?? Date.now(), remoteEtag: etag };
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

  // Garante que as pastas do caminho existam antes de escrever o arquivo.
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
