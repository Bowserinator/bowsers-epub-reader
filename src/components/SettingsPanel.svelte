<script lang="ts">
  import { tick } from 'svelte';
  import Close from 'carbon-icons-svelte/lib/Close.svelte';
  import BookIcon from 'carbon-icons-svelte/lib/Book.svelte';
  import TrashCan from 'carbon-icons-svelte/lib/TrashCan.svelte';
  import TextAlignLeft from 'carbon-icons-svelte/lib/TextAlignLeft.svelte';
  import TextAlignJustify from 'carbon-icons-svelte/lib/TextAlignJustify.svelte';
  import Upload from 'carbon-icons-svelte/lib/Upload.svelte';
  import { marked } from 'marked';
  import DOMPurify from 'dompurify';
  import aboutMd from '../content/about.md?raw';
  import { app, type SettingsSection } from '../app/app.svelte';
  import { ipc } from '../app/ipc';
  import {
    PAGE_SURFACES, TEXT_ALIGNS, THEMES, FONT_SIZE_MAX, FONT_SIZE_MIN, LINE_HEIGHT_MAX, LINE_HEIGHT_MIN, LINE_HEIGHT_STEP, PAGE_MARGIN_MAX, PAGE_MARGIN_MIN,
    PAGE_MARGIN_STEP, WPM_MAX, WPM_MIN, THEME_COLORS, DEFAULT_SETTINGS, type PageSurface, type TextAlign
  } from '../settings/defaults';
  import { BOOK_FONT_ID, bundledFonts, pangramFor, systemId } from '../settings/fontRegistry';
  import { panelSlide } from '../app/actions';
  import Empty from './Empty.svelte';

  const e = $derived(app.effective);
  const SECTIONS: { id: SettingsSection; label: string }[] = [
    { id: 'appearance', label: 'Appearance' }, { id: 'dictionaries', label: 'Dictionaries' }, { id: 'about', label: 'About' }
  ];
  const THEME_LABEL: Record<string, string> = { auto: 'Auto', white: 'White', sepia: 'Sepia', 'light-blue': 'Light blue', charcoal: 'Charcoal', black: 'Black' };
  const SURFACE_LABEL: Record<PageSurface, string> = { gap: 'Gap', 'gap-shadow': 'Gap + shadow', 'no-gap': 'No gap' };

  const ALIGN_LABEL: Record<TextAlign, string> = { left: 'Left aligned', justify: 'Justified' };
  const ALIGN_ICON = { left: TextAlignLeft, justify: TextAlignJustify };
  const BOOK_FONT_LABEL = 'Book original';

  let body: HTMLElement;
  $effect(() => {
    const top = app.settingsScroll[app.settingsSection] ?? 0;
    tick().then(() => { if (body) body.scrollTop = top; });
  });

  let fontQuery = $state('');
  const locale = navigator.language || 'en';
  const collator = new Intl.Collator(locale, { sensitivity: 'base' });
  const q = $derived(fontQuery.trim().toLowerCase());
  const showBookFont = $derived(!q || BOOK_FONT_LABEL.toLowerCase().includes(q));
  const builtIns = $derived(bundledFonts.filter((f) => !q || f.label.toLowerCase().includes(q)));
  const sysFonts = $derived(app.systemFonts.filter((f) => !q || f.toLowerCase().includes(q)).sort(collator.compare));

  const about = $derived(DOMPurify.sanitize(marked.parse(aboutMd, { async: false }) as string));
  let importMsg = $state<string | null>(null);

  async function importDicts(dir: boolean) {
    importMsg = null;
    const paths = await ipc.pickDictionaryFiles(dir);
    if (!paths.length) return;
    const r = await ipc.dictionaryImport(paths).catch((err) => ({ imported: [], errors: [String(err)] }));
    importMsg = r.errors.length ? r.errors.join('\n') : `Imported ${r.imported.length} dictionar${r.imported.length === 1 ? 'y' : 'ies'}.`;
    await app.refreshDictionaries();
  }
  async function updateDict(id: string, patch: Parameters<typeof ipc.dictionaryUpdate>[1]) {
    await ipc.dictionaryUpdate(id, patch);
    await app.refreshDictionaries();
  }
  async function removeDict(id: string, title: string) {
    if (!confirm(`Remove “${title}”? The imported copy will be deleted (your original files are untouched).`)) return;
    await ipc.dictionaryRemove(id);
    await app.refreshDictionaries();
  }
  function wpmInput(ev: Event) {
    const v = Number((ev.currentTarget as HTMLInputElement).value);
    if (Number.isFinite(v)) app.set('readingSpeedWpm', v);
  }
</script>

{#snippet range(label: string, min: number, max: number, step: number, value: number, text: string, key: 'fontSizePx' | 'lineHeight' | 'pageMarginPx')}
  <span class="lab">{label}</span>
  <input type="range" {min} {max} {step} {value} aria-label={label} oninput={(ev) => app.set(key, Number(ev.currentTarget.value))} />
  <span class="val">{text}</span>
{/snippet}

<aside class="settings-panel" aria-label="Settings" transition:panelSlide|global={{ from: 'right', enabled: !app.global.reducedAnimations }}>
  <nav class="snav" aria-label="Settings sections">
    {#each SECTIONS as s}
      <button aria-current={app.settingsSection === s.id ? 'page' : undefined} onclick={() => (app.settingsSection = s.id)}>{s.label}</button>
    {/each}
  </nav>
  <section class="main">
    <div class="shead">
      <h2>{SECTIONS.find((s) => s.id === app.settingsSection)?.label}</h2>
      {#if app.settingsSection === 'about'}<span class="muted">{__APP_VERSION__}</span>{/if}
      <button class="icon-btn close" aria-label="Close settings" onclick={() => (app.settingsOpen = false)}><Close size={20} /></button>
    </div>
    <div class="sbody" bind:this={body} onscroll={() => (app.settingsScroll[app.settingsSection] = body.scrollTop)}>
      {#if app.settingsSection === 'appearance'}
        <div class="override">
          <label class="check"><input type="checkbox" checked={app.overrideEnabled} onchange={(ev) => app.setOverrideEnabled(ev.currentTarget.checked)} /> Override for this book</label>
          <button class="btn" style:visibility={app.overrideEnabled || Object.keys(app.overrides).length ? 'visible' : 'hidden'} onclick={() => app.resetOverride()}>Reset override</button>
          <p class="muted hint">{app.overrideEnabled ? 'Changes to theme, font, size, mode and page options now apply to this book only.' : 'Changes apply to every book.'}</p>
        </div>

        <h3>Theme</h3>
        <div class="themes" role="radiogroup" aria-label="Theme">
          {#each THEMES as t}
            {@const c = t === 'auto' ? null : THEME_COLORS[t]}
            <button role="radio" aria-checked={e.theme === t} class="swatch" onclick={() => app.set('theme', t)}
              style={c ? `background:${c.bg};color:${c.fg}` : 'background:linear-gradient(90deg,#fff 50%,#000 50%)'}>
              <span class="swl" class:auto={t === 'auto'}>{THEME_LABEL[t]}</span>
            </button>
          {/each}
        </div>

        <h3>Book font</h3>
        <input class="fontsearch" type="search" placeholder="Search fonts" aria-label="Search fonts" bind:value={fontQuery} />
        <div class="fonts" role="listbox" aria-label="Book font">
          {#if showBookFont}
            <button role="option" aria-selected={e.fontFamilyId === BOOK_FONT_ID} class="font" onclick={() => app.set('fontFamilyId', BOOK_FONT_ID)}>
              <span class="fname">{BOOK_FONT_LABEL}</span>
              <span class="fsample">Use the fonts defined by the book</span>
            </button>
          {/if}
          {#each builtIns as f (f.id)}
            <button role="option" aria-selected={e.fontFamilyId === f.id} class="font" onclick={() => app.set('fontFamilyId', f.id)}>
              <span class="fname">{f.label}</span>
              <span class="fsample" style="font-family:'{f.family}',{f.fallback}">{pangramFor(locale)}</span>
            </button>
          {/each}
          {#if sysFonts.length}<div class="divider" role="separator">Installed on this computer</div>{/if}
          {#each sysFonts as f (f)}
            <button role="option" aria-selected={e.fontFamilyId === systemId(f)} class="font lazy" onclick={() => app.set('fontFamilyId', systemId(f))}>
              <span class="fname">{f}</span>
              <span class="fsample" style="font-family:'{f.replace(/'/g, '')}',serif">{pangramFor(locale)}</span>
            </button>
          {/each}
        </div>

        <h3>Text layout</h3>
        <div class="layout">
          {@render range('Font size', FONT_SIZE_MIN, FONT_SIZE_MAX, 1, e.fontSizePx, `${e.fontSizePx}px`, 'fontSizePx')}
          {@render range('Line spacing', LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, LINE_HEIGHT_STEP, e.lineHeight, e.lineHeight.toFixed(1), 'lineHeight')}
          {@render range('Page margin', PAGE_MARGIN_MIN, PAGE_MARGIN_MAX, PAGE_MARGIN_STEP, e.pageMarginPx, `${e.pageMarginPx}px`, 'pageMarginPx')}
          <span class="lab">Text alignment</span>
          <div class="seg aligns" role="radiogroup" aria-label="Text alignment">
            {#each TEXT_ALIGNS as t}
              {@const Icon = ALIGN_ICON[t]}
              <button role="radio" aria-checked={e.textAlign === t} title={ALIGN_LABEL[t]} aria-label={ALIGN_LABEL[t]} onclick={() => app.set('textAlign', t)}><Icon size={20} /></button>
            {/each}
          </div>
        </div>

        <h3>Reading speed</h3>
        <div class="rowctl">
          <input type="range" min={WPM_MIN} max={WPM_MAX} step="10" value={e.readingSpeedWpm} aria-label="Reading speed in words per minute" oninput={wpmInput} />
          <input class="num" type="number" min={WPM_MIN} max={WPM_MAX} step="10" value={e.readingSpeedWpm} aria-label="Words per minute" onchange={wpmInput} />
          <span class="muted">wpm</span>
          <button class="btn" onclick={() => app.set('readingSpeedWpm', DEFAULT_SETTINGS.readingSpeedWpm)}>Reset</button>
        </div>
        <p class="muted hint">Used for the “time left in chapter” estimate. This setting is shared by all books.</p>

        <h3>Page surface</h3>
        <div class="seg" role="radiogroup" aria-label="Page surface">
          {#each PAGE_SURFACES as p}
            <button role="radio" aria-checked={e.pageSurface === p} onclick={() => app.set('pageSurface', p)}>{SURFACE_LABEL[p]}</button>
          {/each}
        </div>

        <h3>Page settings</h3>
        <label class="check"><input type="checkbox" checked={e.showChapterRunningHeader} onchange={(ev) => app.set('showChapterRunningHeader', ev.currentTarget.checked)} /> Show chapter title in the top margin</label>
        <label class="check"><input type="checkbox" checked={e.showPageNumber} onchange={(ev) => app.set('showPageNumber', ev.currentTarget.checked)} /> Show page number in the bottom margin</label>
        <label class="check"><input type="checkbox" checked={app.global.showTitle} onchange={(ev) => app.set('showTitle', ev.currentTarget.checked)} /> Show book title in the toolbar</label>
        <label class="check"><input type="checkbox" checked={app.global.autoHideControls} onchange={(ev) => app.set('autoHideControls', ev.currentTarget.checked)} /> Auto-hide toolbars</label>

        <h3>Dictionary</h3>
        <label class="check"><input type="checkbox" checked={app.global.hoverDefine} onchange={(ev) => app.set('hoverDefine', ev.currentTarget.checked)} /> Hover to define (after 1 second)</label>
        <p><button class="btn" onclick={() => (app.shortcutsOpen = true)}>Keyboard shortcuts</button></p>

        <h3>Accessibility</h3>
        <label class="check"><input type="checkbox" checked={app.global.reducedAnimations} onchange={(ev) => app.set('reducedAnimations', ev.currentTarget.checked)} /> Reduced animations</label>
      {:else if app.settingsSection === 'dictionaries'}
        <div class="actions">
          <button class="btn primary" onclick={() => importDicts(false)}><Upload size={16} /> Import files…</button>
          <button class="btn" onclick={() => importDicts(true)}>Import folder…</button>
        </div>
        {#if importMsg}<pre class="msg" role="status">{importMsg}</pre>{/if}
        {#if app.dictionaries.length}
          <ul class="dicts">
            {#each app.dictionaries as d (d.dictId)}
              <li>
                <div class="dhead">
                  <label class="check"><input type="checkbox" checked={d.enabled} onchange={(ev) => updateDict(d.dictId, { enabled: ev.currentTarget.checked })} /> <strong>{d.title}</strong></label>
                  <button class="icon-btn" aria-label="Remove {d.title}" onclick={() => removeDict(d.dictId, d.title)}><TrashCan size={16} /></button>
                </div>
                <div class="muted small">{d.entries.toLocaleString()} entries · {d.sourceLang ?? '??'} → {d.targetLang ?? '??'}{d.attribution ? ` · ${d.attribution}` : ''}</div>
                <div class="dctl">
                  <label>Priority <input class="num" type="number" value={d.priority} onchange={(ev) => updateDict(d.dictId, { priority: Number(ev.currentTarget.value) })} /></label>
                  <label>From <input class="num" type="text" maxlength="3" value={d.sourceLang ?? ''} onchange={(ev) => updateDict(d.dictId, { sourceLang: ev.currentTarget.value.trim().toLowerCase() })} /></label>
                  <label>To <input class="num" type="text" maxlength="3" value={d.targetLang ?? ''} onchange={(ev) => updateDict(d.dictId, { targetLang: ev.currentTarget.value.trim().toLowerCase() })} /></label>
                  {#if app.global.dictionaryMode === 'manual'}
                    <label class="check"><input type="checkbox" checked={app.global.activeDictionaryIds.includes(d.dictId)} onchange={(ev) => app.set('activeDictionaryIds', ev.currentTarget.checked ? [...app.global.activeDictionaryIds, d.dictId] : app.global.activeDictionaryIds.filter((x) => x !== d.dictId))} /> Active</label>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>
          <h3>Language routing</h3>
          <div class="seg" role="radiogroup" aria-label="Dictionary routing">
            <button role="radio" aria-checked={app.global.dictionaryMode === 'auto'} onclick={() => app.set('dictionaryMode', 'auto')}>Automatic</button>
            <button role="radio" aria-checked={app.global.dictionaryMode === 'manual'} onclick={() => app.set('dictionaryMode', 'manual')}>Manual</button>
          </div>
          <p class="muted hint" style="margin-top:4px">Automatic picks dictionaries by the book’s language and the script of the word. Manual uses only the dictionaries ticked “Active”, in priority order.</p>
        {:else}
          <Empty icon={BookIcon} text="No dictionaries installed; import a StarDict dictionary." />
        {/if}
      {:else}
        <article class="about">{@html about}</article>
        <p class="muted">Version {__APP_VERSION__}</p>
      {/if}
    </div>
  </section>
</aside>

<style>
  .settings-panel { flex-direction: row; }
  .snav { flex: 0 0 160px; width: 160px; border-right: 1px solid var(--border); padding: 12px 8px; display: flex; flex-direction: column; gap: 2px; }
  .snav button { text-align: left; border: 0; background: transparent; padding: 0 12px; min-height: var(--target); border-radius: var(--radius); }
  .snav button:hover { background: var(--hover); }
  .snav button[aria-current='page'] { background: var(--hover); font-weight: 600; }
  .main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
  .shead { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border); }
  .shead h2 { margin: 0; font-size: 16px; flex: 1; }
  .sbody { overflow: auto; padding: 8px 20px 32px; flex: 1; min-height: 0; }
  h3 { margin: 20px 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; }
  .override { padding: 8px 0 0; min-height: 74px; align-content: flex-start; display: flex; flex-wrap: wrap; gap: 0 12px; align-items: center; }
  .hint { margin: 0; font-size: 12px; flex-basis: 100%; }
  .check { display: flex; gap: 8px; align-items: center; min-height: 32px; }
  .themes { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 8px; }
  .swatch { min-height: 48px; border: 2px solid var(--border); border-radius: var(--radius); font-size: 12px; font-weight: 500; }
  .swatch[aria-checked='true'] { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); }
  .swl.auto { background: linear-gradient(90deg, #000 50%, #fff 50%); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .fontsearch, .fonts { display: block; max-width: 600px; margin-left: auto; }
  .fonts { margin-top: 8px; max-height: 280px; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius); }
  .font { display: flex; flex-direction: column; align-items: flex-start; width: 100%; border: 0; background: transparent; padding: 6px 12px; text-align: left; min-height: var(--target); }
  .font.lazy { content-visibility: auto; contain-intrinsic-size: 54px; }
  .font:hover { background: var(--hover); }
  .font[aria-selected='true'] { background: var(--hover); box-shadow: inset 3px 0 0 var(--accent); }
  .fname { font-size: 11px; color: var(--muted); }
  .fsample { font-size: 16px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .divider { padding: 6px 12px; font-size: 11px; color: var(--muted); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--bg); position: sticky; top: 0; z-index: 1; }
  .layout { display: grid; grid-template-columns: 110px minmax(120px, 1fr) 48px; align-items: center; gap: 8px 12px; max-width: 600px; }
  .layout input[type='range'] { width: 100%; }
  .aligns { grid-column: 2; justify-self: start; }
  .aligns button { display: inline-flex; align-items: center; justify-content: center; padding: 0 12px; }
  .rowctl { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .rowctl input[type='range'] { flex: 1 1 160px; min-width: 120px; }
  .val { min-width: 48px; text-align: right; }
  .num { width: 72px; min-width: 0; }
  .actions { display: flex; gap: 8px; margin: 8px 0; }
  .msg { white-space: pre-wrap; background: var(--bg); border: 1px solid var(--border); padding: 8px 12px; border-radius: var(--radius); font-family: inherit; font-size: 12px; }
  .dicts { list-style: none; padding: 0; margin: 12px 0; display: flex; flex-direction: column; gap: 12px; }
  .dicts li { border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 12px; background: var(--bg); }
  .dhead { display: flex; justify-content: space-between; align-items: center; }
  .small { font-size: 12px; }
  .dctl { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-top: 6px; font-size: 12px; }
  .about :global(table) { border-collapse: collapse; } .about :global(td), .about :global(th) { border: 1px solid var(--border); padding: 4px 8px; }
</style>
