import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@open-design/components';
import type { ProjectFile } from '@open-design/contracts';
import { projectFileUrl, projectRawUrl } from '../providers/registry';
import { buildSrcdoc } from '../runtime/srcdoc';
import type { Dict } from '../i18n/types';
import { Icon, type IconName } from './Icon';
import styles from './TaskDeliverableCard.module.css';

type TranslateFn = (key: keyof Dict, vars?: Record<string, string | number>) => string;

// Iframe thumbnails above this size fetch too much for a hero preview; fall
// back to the icon placeholder (mirrors DesignFilesPanel's threshold).
const HTML_PREVIEW_MAX_BYTES = 900_000;

export interface TaskDeliverableCardProps {
  projectId: string;
  /**
   * The run's headline product artifact (artifact mode). Null when the turn
   * produced no previewable product — the card then renders changes mode
   * (a compact "task completed · N files changed" summary).
   */
  primary: ProjectFile | null;
  /** Additional / attached outputs produced by the same task. */
  secondary: ProjectFile[];
  /** Changed-file count for changes mode. */
  changedCount: number;
  /** Completion status label (e.g. "Done"). */
  statusLabel: string;
  /** Run duration in ms, for the changes-mode subtitle. */
  elapsedMs?: number;
  /** Open a file in the workspace (also used for View / Preview / Play). */
  onOpen: (name: string) => void;
  /** Open the file's Share/Deploy menu — only when it makes sense (HTML). */
  onShare?: (name: string) => void;
  /** Open the file's Download/Export menu. */
  onDownload?: (name: string) => void;
  /** Open the workspace's "All project files" tab. */
  onOpenAllFiles: () => void;
  t: TranslateFn;
}

function formatElapsed(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.floor(s - m * 60).toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m - h * 60).toString().padStart(2, '0')}m`;
}

function baseDirForFile(name: string): string {
  const idx = name.lastIndexOf('/');
  return idx === -1 ? '' : name.slice(0, idx);
}

function kindIcon(kind: ProjectFile['kind']): IconName {
  switch (kind) {
    case 'html':
    case 'code':
      return 'file-code';
    case 'image':
    case 'sketch':
      return 'image';
    case 'video':
      return 'play';
    case 'audio':
      return 'play';
    case 'presentation':
      return 'slides';
    case 'pdf':
    case 'document':
    case 'spreadsheet':
      return 'file';
    default:
      return 'file';
  }
}

function humanBytes(n: number): string {
  if (!n || n < 1024) return `${n || 0} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function isPlayable(kind: ProjectFile['kind']): boolean {
  return kind === 'video' || kind === 'audio';
}

function isHtmlLike(file: ProjectFile): boolean {
  return file.kind === 'html' || file.kind === 'presentation' || /\.html?$/i.test(file.name);
}

/** Human title for the deliverable: manifest title, else the humanized stem. */
export function deliverableTitle(file: ProjectFile): string {
  const manifestTitle = file.artifactManifest?.title;
  if (typeof manifestTitle === 'string' && manifestTitle.trim()) return manifestTitle.trim();
  const base = (file.name.split('/').pop() ?? file.name).replace(/\.[^.]+$/, '');
  const words = base.replace(/[-_]+/g, ' ').trim();
  return words ? words.replace(/\b\w/g, (c) => c.toUpperCase()) : file.name;
}

function kindLabel(t: TranslateFn, kind: ProjectFile['kind']): string {
  const key = `deliverable.kind.${kind}` as keyof Dict;
  // Every kind has a localized label; fall back to the raw kind if a future
  // ProjectFileKind lands before its key does.
  const label = t(key);
  return label === key ? kind : label;
}

/** Hero preview of the primary deliverable, by kind. */
function DeliverablePreview({
  projectId,
  file,
  t,
}: {
  projectId: string;
  file: ProjectFile;
  t: TranslateFn;
}) {
  const url = projectFileUrl(projectId, file.name);
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const htmlLike = isHtmlLike(file);
  const tooLarge = file.size > HTML_PREVIEW_MAX_BYTES;

  useEffect(() => {
    setSrcDoc(null);
    setFrameLoaded(false);
    setLoadFailed(false);
    if (!htmlLike || tooLarge) return;
    const controller = new AbortController();
    let cancelled = false;
    void fetch(`${url}?v=${Math.round(file.mtime)}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.text() : null))
      .then((html) => {
        if (cancelled) return;
        if (html === null) {
          setLoadFailed(true);
          return;
        }
        setSrcDoc(buildSrcdoc(html, { baseHref: projectRawUrl(projectId, baseDirForFile(file.name)) }));
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [file.mtime, file.name, htmlLike, projectId, tooLarge, url]);

  if (htmlLike && srcDoc !== null) {
    return (
      <div className={styles.previewFrame}>
        <iframe
          title={file.name}
          srcDoc={srcDoc}
          sandbox="allow-scripts allow-downloads"
          loading="lazy"
          scrolling="no"
          className={frameLoaded ? styles.previewLoaded : undefined}
          onLoad={() => setFrameLoaded(true)}
        />
        {!frameLoaded ? <span className={styles.previewLoading} aria-hidden /> : null}
      </div>
    );
  }
  if (file.kind === 'image' || file.kind === 'sketch') {
    return (
      <div className={styles.previewMedia}>
        <img src={`${url}?v=${Math.round(file.mtime)}`} alt={file.name} loading="lazy" />
      </div>
    );
  }
  if (file.kind === 'video') {
    return (
      <div className={styles.previewMedia}>
        <video src={url} controls playsInline preload="metadata" />
      </div>
    );
  }
  if (file.kind === 'audio') {
    return (
      <div className={styles.previewAudio}>
        <Icon name="play" size={28} />
        <audio src={url} controls preload="metadata" />
      </div>
    );
  }
  return (
    <div className={styles.previewPlaceholder} role="img" aria-label={file.name}>
      <Icon name={kindIcon(file.kind)} size={34} />
      <span>{loadFailed || tooLarge ? kindLabel(t, file.kind) : null}</span>
    </div>
  );
}

function DeliverableActionsMenu({
  projectId,
  file,
  onShare,
  onDownload,
  t,
}: {
  projectId: string;
  file: ProjectFile;
  onShare?: (name: string) => void;
  onDownload?: (name: string) => void;
  t: TranslateFn;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canShare = Boolean(onShare) && isHtmlLike(file);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div className={styles.menuWrap} ref={wrapRef}>
      <Button
        variant="ghost"
        size="icon"
        className={styles.menuTrigger}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('designs.menuMore')}
        title={t('designs.menuMore')}
      >
        <Icon name="more-horizontal" size={17} />
      </Button>
      {open ? (
        <div className={styles.menu} role="menu" aria-label={t('designs.menuMore')}>
          {canShare ? (
            <Button
              variant="ghost"
              className={styles.menuItem}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onShare?.(file.name);
              }}
            >
              <Icon name="share" size={16} />
              <span>{t('deliverable.share')}</span>
            </Button>
          ) : null}
          {onDownload ? (
            <Button
              variant="ghost"
              className={styles.menuItem}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onDownload(file.name);
              }}
            >
              <Icon name="download" size={16} />
              <span>{t('deliverable.download')}</span>
            </Button>
          ) : (
            <a
              className={styles.menuItem}
              href={projectFileUrl(projectId, file.name)}
              download={file.name}
              role="menuitem"
              onClick={() => setOpen(false)}
            >
              <Icon name="download" size={16} />
              <span>{t('deliverable.download')}</span>
            </a>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function TaskDeliverableCard({
  projectId,
  primary,
  secondary,
  changedCount,
  statusLabel,
  elapsedMs,
  onOpen,
  onShare,
  onDownload,
  onOpenAllFiles,
  t,
}: TaskDeliverableCardProps) {
  const title = useMemo(() => (primary ? deliverableTitle(primary) : ''), [primary]);

  // Changes mode: no previewable product headlines this turn, so summarize
  // the completion (status + N files changed) and route the user to the files.
  if (!primary) {
    return (
      <div className={`${styles.card} ${styles.cardChanges}`} data-testid="task-deliverable-card">
        <div className={styles.changesHead}>
          <span className={styles.changesCheck} aria-hidden>
            <Icon name="check" size={15} />
          </span>
          <div className={styles.headText}>
            <span className={styles.name}>{statusLabel}</span>
            <span className={styles.changesSub}>
              {t('deliverable.filesChanged', { count: changedCount })}
              {elapsedMs != null ? ` · ${formatElapsed(elapsedMs)}` : ''}
            </span>
          </div>
        </div>
        <Button variant="ghost" className={styles.viewAll} onClick={onOpenAllFiles}>
          <Icon name="folder" size={14} />
          <span>{t('deliverable.viewAllFiles', { count: changedCount })}</span>
        </Button>
      </div>
    );
  }

  const totalFiles = 1 + secondary.length;
  const playable = isPlayable(primary.kind);
  const footerFile = secondary[0] ?? primary;

  return (
    <div className={styles.card} data-testid="task-deliverable-card">
      <div className={styles.head}>
        <span className={styles.headIcon} aria-hidden>
          <Icon name={kindIcon(primary.kind)} size={16} />
        </span>
        <div className={styles.headText}>
          <span className={styles.name} title={title}>
            {title}
          </span>
        </div>
        <DeliverableActionsMenu
          projectId={projectId}
          file={primary}
          onShare={onShare}
          onDownload={onDownload}
          t={t}
        />
      </div>

      <button
        type="button"
        className={styles.preview}
        aria-label={t(playable ? 'deliverable.play' : 'deliverable.preview')}
        onClick={() => onOpen(primary.name)}
      >
        <DeliverablePreview projectId={projectId} file={primary} t={t} />
      </button>

      <div className={styles.footer}>
        <Button
          variant="ghost"
          className={styles.fileTile}
          onClick={() => onOpen(footerFile.name)}
          title={footerFile.name}
        >
          <span className={styles.fileTileIcon} aria-hidden>
            <Icon name={kindIcon(footerFile.kind)} size={18} />
          </span>
          <span className={styles.fileTileText}>
            <span className={styles.fileTileName}>
              {footerFile.name.split('/').pop() ?? footerFile.name}
            </span>
            <span className={styles.fileTileMeta}>
              {kindLabel(t, footerFile.kind)}
              {footerFile.size ? ` · ${humanBytes(footerFile.size)}` : ''}
            </span>
          </span>
        </Button>
        <Button variant="ghost" className={styles.viewAll} onClick={onOpenAllFiles}>
          <Icon name="folder" size={18} />
          <span>{t('deliverable.viewAllFiles', { count: totalFiles })}</span>
        </Button>
      </div>
    </div>
  );
}
