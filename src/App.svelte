<script lang="ts">
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { app } from './app/app.svelte';
  import { PANEL_SLIDE_MS, toastOut } from './app/actions';
  import TopBar from './components/TopBar.svelte';
  import BottomBar from './components/BottomBar.svelte';
  import Drawer from './components/Drawer.svelte';
  import ReaderView from './components/ReaderView.svelte';
  import SettingsPanel from './components/SettingsPanel.svelte';
  import GoToDialog from './components/GoToDialog.svelte';
  import BookInfoDialog from './components/BookInfoDialog.svelte';
  import ShortcutsModal from './components/ShortcutsModal.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import DefineTooltip from './components/DefineTooltip.svelte';
  import EmptyState from './components/EmptyState.svelte';
  import ErrorView from './components/ErrorView.svelte';

  onMount(() => {
    app.boot();
    const kd = (e: KeyboardEvent) => app.handleKey(e);
    const pd = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (app.hover && !target?.closest?.('.def')) app.dismissHover();
      if (app.contextMenu && !target?.closest?.('.ctx')) app.closeContextMenu();
      if (app.modeMenuOpen && !target?.closest?.('.modewrap')) app.modeMenuOpen = false;
      if (!app.drawer && !app.settingsOpen) return;
      if (target?.closest?.('.drawer, .settings-panel, .bar, .popover, .overlay')) return;
      app.closePanels();
    };
    // Focus moving into a book iframe is a click on the book.
    const blur = () => setTimeout(() => { if (document.activeElement?.tagName === 'IFRAME') { app.closePanels(); app.modeMenuOpen = false; app.dismissHover(); } });
    const ctx = (e: MouseEvent) => {
      e.preventDefault();
      if ((e.target as HTMLElement | null)?.closest?.('.reader-col')) app.openContextMenu(e.clientX, e.clientY);
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('pointerdown', pd, true);
    window.addEventListener('blur', blur);
    window.addEventListener('contextmenu', ctx);
    return () => {
      window.removeEventListener('keydown', kd); window.removeEventListener('pointerdown', pd, true);
      window.removeEventListener('blur', blur); window.removeEventListener('contextmenu', ctx);
    };
  });

  $effect(() => { document.documentElement.dataset.theme = app.resolvedTheme; });

  $effect(() => { if (app.drawer || app.settingsOpen) app.modeMenuOpen = false; });

  $effect(() => { if (app.drawer || app.settingsOpen || app.modeMenuOpen) app.dismissHover(); });

  $effect(() => {
    void app.effective.theme; void app.effective.fontFamilyId; void app.effective.fontSizePx; void app.effective.lineHeight; void app.effective.textAlign; void app.systemFonts.length; void app.osDark;
    if (app.phase === 'ready') app.applyAppearance();
  });

  $effect(() => {
    const mode = app.effectiveMode, two = app.twoPageActive, surface = app.effective.pageSurface, margin = app.effective.pageMarginPx;
    if (app.phase === 'ready') app.applyMode(mode, two, surface, margin);
  });
</script>

{#if app.phase === 'loading'}
  <div class="boot muted" role="status">Opening…</div>
{:else if app.phase === 'empty'}
  <EmptyState />
{:else if app.phase === 'error'}
  <ErrorView />
{:else}
  <div class="shell">
    <TopBar />
    <div class="middle">
      {#if app.drawer}<Drawer />{/if}
      <div class="reader-col"><ReaderView /></div>
      {#if app.drawer || app.settingsOpen}
        <div class="scrim" aria-hidden="true" transition:fade={{ duration: app.global.reducedAnimations ? 0 : PANEL_SLIDE_MS }}></div>
      {/if}
      {#if app.settingsOpen}<SettingsPanel />{/if}
    </div>
    <BottomBar />
  </div>

  {#if app.notice}
    <div class="toast popover" class:error={app.noticeIsError} role="status" out:toastOut={{ enabled: !app.global.reducedAnimations }}>
      <span>{app.notice}</span>
      <button class="btn" onclick={() => (app.notice = null)}>OK</button>
    </div>
  {/if}
  {#if app.contextMenu}<ContextMenu />{/if}
  {#if app.hover}<DefineTooltip />{/if}
  {#if app.goToOpen}<GoToDialog />{/if}
  {#if app.bookInfoOpen}<BookInfoDialog />{/if}
  {#if app.shortcutsOpen}<ShortcutsModal />{/if}
{/if}

<style>
  .boot { height: 100%; display: flex; align-items: center; justify-content: center; }
  .toast { left: 50%; transform: translateX(-50%); bottom: 76px; padding: 8px 12px; display: flex; gap: 12px; align-items: center; max-width: 90vw; z-index: 70; }
  .toast.error { background: #ffd9d9; color: #3a1111; border-color: #e8a5a5; }
  .toast.error :global(.btn) { background: #fff0f0; color: inherit; border-color: #e8a5a5; }
</style>
