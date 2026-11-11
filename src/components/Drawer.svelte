<script lang="ts">
  import ListBulleted from 'carbon-icons-svelte/lib/ListBulleted.svelte';
  import BookmarkIcon from 'carbon-icons-svelte/lib/Bookmark.svelte';
  import Edit from 'carbon-icons-svelte/lib/Edit.svelte';
  import SearchIcon from 'carbon-icons-svelte/lib/Search.svelte';
  import ChevronRight from 'carbon-icons-svelte/lib/ChevronRight.svelte';
  import ChevronDown from 'carbon-icons-svelte/lib/ChevronDown.svelte';
  import Close from 'carbon-icons-svelte/lib/Close.svelte';
  import TrashCan from 'carbon-icons-svelte/lib/TrashCan.svelte';
  import { app, type Drawer } from '../app/app.svelte';
  import { highlightFill } from '../reader/ReaderEngine';
  import { formatDate } from '../app/format';
  import type { TocNode } from '../reader/locations';
  import { panelSlide } from '../app/actions';
  import Empty from './Empty.svelte';

  let collapsed = $state(new Set<string>());
  function toggle(id: string) { const n = new Set(collapsed); n.has(id) ? n.delete(id) : n.add(id); collapsed = n; }

  const TITLES: Record<Exclude<Drawer, null>, string> = { toc: 'Chapters', bookmarks: 'Bookmarks', highlights: 'Highlights', search: 'Search' };
  const title = $derived(TITLES[app.drawer!]);
  const s = $derived(app.search);
</script>

{#snippet tocList(nodes: TocNode[])}
  <ul class="toc" role={nodes[0]?.depth ? 'group' : 'tree'}>
    {#each nodes as n (n.id)}
      <li role="treeitem" aria-expanded={n.subitems.length ? !collapsed.has(n.id) : undefined} aria-selected={false}>
        <div class="row" style="padding-left:{8 + n.depth * 5}px">
          {#if n.subitems.length}
            <button class="exp" aria-label={collapsed.has(n.id) ? 'Expand' : 'Collapse'} onclick={() => toggle(n.id)}>
              {#if collapsed.has(n.id)}<ChevronRight size={12} />{:else}<ChevronDown size={12} />{/if}
            </button>
          {:else}<span class="exp"></span>{/if}
          <button class="item" onclick={() => app.goToHref(n.href)} title={n.label}>
            <span class="lbl">{n.label}</span>
            <span class="muted pg">{app.tocPage(n)}</span>
          </button>
        </div>
        {#if n.subitems.length && !collapsed.has(n.id)}{@render tocList(n.subitems)}{/if}
      </li>
    {/each}
  </ul>
{/snippet}

{#snippet entry(o: { text: string; sub: string; page: string; color?: string; removeLabel: string; open: () => void; remove: () => void })}
  <li>
    <button class="item" class:colored={!!o.color} style:--hl={o.color} onclick={o.open}>
      <span class="bmmain">
        <span class="lbl">{o.text}</span>
        <span class="muted sub">{o.sub}</span>
      </span>
      {#if o.page}<span class="muted pg">{o.page}</span>{/if}
    </button>
    <button class="icon-btn" aria-label={o.removeLabel} title="Remove" onclick={o.remove}><TrashCan size={16} /></button>
  </li>
{/snippet}

<aside class="drawer" aria-label={title} transition:panelSlide|global={{ from: 'left', enabled: !app.global.reducedAnimations }}>
  <div class="panel-head">
    <span>{title}</span>
    <button class="icon-btn" aria-label="Close panel" onclick={() => (app.drawer = null)}><Close size={20} /></button>
  </div>

  {#if app.drawer === 'toc'}
    <div class="panel-body">
      {#if app.toc.length}
        {@render tocList(app.toc)}
      {:else}
        <Empty icon={ListBulleted} text="This book doesn't contain a table of contents." />
      {/if}
    </div>
  {:else if app.drawer === 'bookmarks'}
    <div class="panel-body">
      {#if app.bookmarks.length}
        <ul class="bm">
          {#each app.bookmarks as b (b.id)}
            {@const v = app.bookmarkView(b)}
            {@render entry({ text: v.title, sub: formatDate(b.createdAt), page: v.page, removeLabel: 'Remove bookmark', open: () => app.goToCfi(b.cfi), remove: () => app.removeBookmark(b.id) })}
          {/each}
        </ul>
      {:else}
        <Empty icon={BookmarkIcon} text="You have no bookmarks; add one on the top right." />
      {/if}
    </div>
  {:else if app.drawer === 'highlights'}
    <div class="panel-body">
      {#if app.highlights.length}
        <ul class="bm">
          {#each app.highlightsInOrder as h (h.id)}
            {@const v = app.highlightView(h)}
            {@render entry({
              text: h.selectedText, sub: [v.chapter, formatDate(h.createdAt)].filter(Boolean).join(' · '), page: v.page, color: highlightFill(h.color),
              removeLabel: 'Remove highlight', open: () => app.goToCfi(h.cfiRange), remove: () => app.removeHighlight(h.id)
            })}
          {/each}
        </ul>
      {:else}
        <Empty icon={Edit} text="You have no highlights; right-click selected text to add one." />
      {/if}
    </div>
  {:else if app.drawer === 'search'}
    <div class="searchbox">
      <input id="search-input" type="search" placeholder="Search in book" aria-label="Search in book" bind:value={app.search.query} oninput={() => app.onSearchInput()}
        onkeydown={(e) => { if (e.key === 'Enter') app.runSearch(); }} />
      <button class="icon-btn tog" aria-pressed={s.regex} title="Regular expression" aria-label="Regular expression" onclick={() => { app.search.regex = !s.regex; app.runSearch(); }}>.*</button>
      <button class="icon-btn tog" aria-pressed={s.caseSensitive} title="Match case" aria-label="Match case" onclick={() => { app.search.caseSensitive = !s.caseSensitive; app.runSearch(); }}>Aa</button>
    </div>
    <div class="panel-body" aria-live="polite">
      {#if app.indexing}<div class="muted note">Indexing the book…</div>{/if}
      {#if s.error}
        <div class="err danger-text" role="alert">{s.error}</div>
      {:else if s.query.trim() && !s.running && s.done && s.hits.length === 0}
        <Empty icon={SearchIcon} text="No matches found." />
      {:else if s.hits.length}
        <div class="muted note">{s.hits.length}{s.truncated ? '+' : ''} result{s.hits.length === 1 ? '' : 's'}{s.running ? ' …' : ''}</div>
        <ul class="hits">
          {#each s.hits as h, i (i)}
            {@const l = app.searchLabel(h)}
            <li>
              <button class="item hit" onclick={() => app.goToHit(h)}>
                <span class="hitmeta muted"><span class="ch">{l.chapter}</span><span>{l.page}</span></span>
                <span class="snip">…{h.before}<mark>{h.matched}</mark>{h.after}…</span>
              </button>
            </li>
          {/each}
        </ul>
      {:else if !s.query.trim()}
        <Empty icon={SearchIcon} text="Type to search the whole book." />
      {/if}
    </div>
  {/if}
</aside>

<style>
  ul { list-style: none; margin: 0; padding: 0; }
  .row { display: flex; align-items: flex-start; }
  .exp { flex: 0 0 14px; width: 14px; height: 36px; border: 0; background: transparent; display: inline-flex; align-items: center; justify-content: center; padding: 0; }
  .item { flex: 1 1 auto; min-width: 0; display: flex; gap: 8px; justify-content: space-between; align-items: flex-start; text-align: left; border: 0; background: transparent; padding: 8px; min-height: var(--target); border-radius: 0; }
  .item:hover { background: var(--hover); }
  .lbl { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .pg { flex: 0 0 auto; font-size: 12px; line-height: 20px; }
  .bm li, .hits li { display: flex; align-items: flex-start; }
  .bmmain { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .sub { font-size: 12px; }
  .colored { border-left: 3px solid var(--hl); }
  .colored .lbl { display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .searchbox { display: flex; gap: 4px; padding: 0 12px 8px; align-items: center; }
  .tog { min-width: var(--control-h); padding: 0 6px; border: 1px solid var(--border); font-size: 13px; }
  .tog[aria-pressed='true'] { background: var(--accent); color: var(--on-accent); border-color: transparent; }
  .note { padding: 4px 12px; font-size: 12px; }
  .err { padding: 8px 12px; }
  .hit { flex-direction: column; align-items: stretch; gap: 2px; min-width: 0; }
  .hitmeta { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; font-size: 12px; }
  .hitmeta > span:last-child { flex: 0 0 auto; }
  .ch { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .snip { font-size: 13px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
  mark { background: #ffd43b; color: #111; border-radius: 0; padding: 0 1px; }
</style>
