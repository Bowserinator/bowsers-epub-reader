<script lang="ts">
  import TableOfContents from 'carbon-icons-svelte/lib/TableOfContents.svelte';
  import Bookmark from 'carbon-icons-svelte/lib/Bookmark.svelte';
  import Edit from 'carbon-icons-svelte/lib/Edit.svelte';
  import BookmarkFilled from 'carbon-icons-svelte/lib/BookmarkFilled.svelte';
  import Search from 'carbon-icons-svelte/lib/Search.svelte';
  import Add from 'carbon-icons-svelte/lib/Add.svelte';
  import Subtract from 'carbon-icons-svelte/lib/Subtract.svelte';
  import ViewOff from 'carbon-icons-svelte/lib/ViewOff.svelte';
  import View from 'carbon-icons-svelte/lib/View.svelte';
  import Settings from 'carbon-icons-svelte/lib/Settings.svelte';
  import Book from 'carbon-icons-svelte/lib/Book.svelte';
  import { app } from '../app/app.svelte';
  import { AutoHide } from '../app/autohide.svelte';
  import { READER_MODES, type ReaderMode } from '../settings/defaults';

  const ICON_PX = 20;

  const MODE_LABEL: Record<ReaderMode, string> = {
    spread: 'Two-page spread', 'single-scroll': 'Single page, scrolling', continuous: 'Continuous scroll', 'chapter-spread': 'Chapter spreads'
  };

  const hide = new AutoHide();
  const hidden = $derived(hide.hidden(app.effective.autoHideControls, app.modeMenuOpen));
</script>

<header class="bar top" class:hidden role="toolbar" aria-label="Reader controls" onpointerleave={hide.leave}
  onfocusin={hide.focusIn} onfocusout={hide.focusOut}>
  <div class="zone" onpointerenter={hide.enter} aria-hidden="true"></div>
  <div class="content" onpointerenter={hide.enter}>
    <div class="group">
      <button class="icon-btn" title="Chapters (table of contents)" aria-label="Chapters" aria-expanded={app.drawer === 'toc'} onclick={() => app.toggleDrawer('toc')}><TableOfContents size={ICON_PX} /></button>
      <button class="icon-btn" title="Bookmarks" aria-label="Bookmarks" aria-expanded={app.drawer === 'bookmarks'} onclick={() => app.toggleDrawer('bookmarks')}><Bookmark size={ICON_PX} /></button>
      <button class="icon-btn" title="Highlights" aria-label="Highlights" aria-expanded={app.drawer === 'highlights'} onclick={() => app.toggleDrawer('highlights')}><Edit size={ICON_PX} /></button>
      <button class="icon-btn" title="Search (Ctrl+F)" aria-label="Search" aria-expanded={app.drawer === 'search'} onclick={() => app.toggleDrawer('search')}><Search size={ICON_PX} /></button>
    </div>

    <div class="title" title={app.bookTitle} role="button" tabindex="0" onclick={() => (app.bookInfoOpen = true)}
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); app.bookInfoOpen = true; } }}>{app.effective.showTitle ? app.bookTitle : ''}</div>

    <div class="group">
      <button class="icon-btn" title="Go to page (Ctrl+G)" aria-label="Go to page" onclick={() => (app.goToOpen = true)}><span class="glyph" aria-hidden="true">#</span></button>
      <button class="icon-btn" title="Smaller text (Ctrl+-)" aria-label="Decrease font size" onclick={() => app.fontSize(-1)}><Subtract size={ICON_PX} /></button>
      <button class="icon-btn" title="Larger text (Ctrl+=)" aria-label="Increase font size" onclick={() => app.fontSize(1)}><Add size={ICON_PX} /></button>
      <button class="icon-btn" title="Bookmark this page (Ctrl+B)" aria-label={app.isBookmarked ? 'Remove bookmark' : 'Add bookmark'} aria-pressed={app.isBookmarked} onclick={() => app.toggleBookmark()}>
        {#if app.isBookmarked}<BookmarkFilled size={ICON_PX} />{:else}<Bookmark size={ICON_PX} />{/if}
      </button>
      <button class="icon-btn" title="Auto-hide controls (Ctrl+H)" aria-label={app.effective.autoHideControls ? 'Always show controls' : 'Auto-hide controls'} aria-pressed={app.effective.autoHideControls} onclick={() => app.set('autoHideControls', !app.effective.autoHideControls)}>
        {#if app.effective.autoHideControls}<ViewOff size={ICON_PX} />{:else}<View size={ICON_PX} />{/if}
      </button>
      <div class="modewrap">
        <button class="icon-btn" title="Reading mode" aria-label="Reading mode: {MODE_LABEL[app.effective.readerMode]}" aria-haspopup="menu" aria-expanded={app.modeMenuOpen} onclick={() => (app.modeMenuOpen = !app.modeMenuOpen)}><Book size={ICON_PX} /></button>
        {#if app.modeMenuOpen}
          <div class="popover menu" role="menu" aria-label="Reading mode">
            {#each READER_MODES as m}
              <button role="menuitemradio" aria-checked={app.effective.readerMode === m} onclick={() => { app.set('readerMode', m); app.modeMenuOpen = false; }}>
                <span class="tick">{app.effective.readerMode === m ? '✓' : ''}</span>{MODE_LABEL[m]}
              </button>
            {/each}
          </div>
        {/if}
      </div>
      <button class="icon-btn" title="Settings (Ctrl+,)" aria-label="Settings" aria-expanded={app.settingsOpen} onclick={() => app.toggleSettings()}><Settings size={ICON_PX} /></button>
    </div>
  </div>
</header>

<style>
  .modewrap { position: relative; }
  .menu { position: absolute; top: calc(100% + 4px); right: 0; padding: 4px; display: flex; flex-direction: column; min-width: 230px; }
  .menu button { display: flex; gap: 8px; align-items: center; text-align: left; border: 0; background: transparent; padding: 0 12px; min-height: var(--target); border-radius: 0; }
  .menu button:hover { background: var(--hover); }
  .tick { width: 16px; }
</style>
