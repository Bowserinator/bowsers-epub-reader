<script lang="ts">
  import { onMount } from 'svelte';
  import { app } from '../app/app.svelte';
  import { onWheel } from '../app/actions';
  import { attachSwipe, edgeSide, wheelPager } from '../reader/touch';
  import { PAGE_BAR_GAP, PAGE_GAP, PAGE_OUTER, isScrollMode } from '../settings/defaults';

  let host: HTMLElement;
  let reader: HTMLElement;
  onMount(() => {
    app.startReader(host);
    return attachSwipe(reader, { isPaginated: () => !scrolling, onSwipe: (d) => app.turn(d === 'left' ? 'right' : 'left') });
  });

  const e = $derived(app.effective);
  const two = $derived(app.twoPageActive);
  const gapPx = $derived(PAGE_GAP[e.pageSurface]);
  // Between separate page surfaces the text columns' own padding already supplies the margin, so the stage
  // extends past the surfaces to keep the inner margin equal to the outer one.
  const bleedPx = $derived(two ? gapPx / 2 : 0);
  const scrolling = $derived(isScrollMode(app.effectiveMode));
  const loc = $derived(app.loc);
  const numeric = $derived(/^\d+$/.test(app.pageLabel));
  // The right-hand page number is hidden on a deliberately blank right page (chapter-spread).
  const rightBlank = $derived(!!loc && app.effectiveMode === 'chapter-spread' && loc.page >= loc.pagesInSection);
  const rightNum = $derived(numeric && !rightBlank ? String(Number(app.pageLabel) + 1) : '');

  const pager = wheelPager(() => !scrolling, (d) => (d > 0 ? app.next() : app.prev()));

  // Clicking the left or right margin beside the text turns the page.
  function marginClick(ev: MouseEvent) {
    const t = ev.target as HTMLElement;
    if (scrolling || t.closest('button, a, .banner')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const text = host.getBoundingClientRect();
    if (ev.clientX >= text.left && ev.clientX <= text.right) return;
    const r = reader.getBoundingClientRect();
    app.turn(edgeSide(ev.clientX - r.left, r.width));
  }
</script>

<div class="reader" bind:this={reader} use:onWheel={pager} onclick={marginClick} role="presentation"
  style:touch-action={scrolling ? null : 'pan-y pinch-zoom'}
  style="--gap:{gapPx}px;--outer:{PAGE_OUTER}px;--outer-v:{e.autoHideControls ? PAGE_OUTER : PAGE_BAR_GAP}px;--inset:{e.pageMarginPx}px;--stage-pad:{bleedPx ? 0 : e.pageMarginPx}px;--stage-bleed:{bleedPx}px">
  <div class="shells" aria-hidden="true">
    {#if two}
      <div class="page" class:shadow={e.pageSurface === 'gap-shadow'}></div>
      <div class="gap"></div>
      <div class="page" class:shadow={e.pageSurface === 'gap-shadow'}></div>
    {:else}
      <div class="page" class:shadow={e.pageSurface === 'gap-shadow'}></div>
    {/if}
  </div>

  <div class="hdr" aria-hidden="true">
    {#if e.showChapterRunningHeader}
      {#if two}
        <!-- Only the left page carries the chapter title in a two-page spread. -->
        <div class="slot" style="text-align:left">{app.chapterTitle}</div>
        <div style="flex:0 0 {gapPx}px"></div>
        <div class="slot"></div>
      {:else if scrolling}
        <div class="slot" style="text-align:left">{app.chapterTitle}</div>
      {:else}
        <div class="slot">{app.chapterTitle}</div>
      {/if}
    {/if}
  </div>

  <div class="stagewrap">
    <div class="stage" bind:this={host} role="document" aria-label={app.bookTitle}></div>
  </div>

  <div class="ftr" aria-hidden="true">
    {#if e.showPageNumber && !scrolling}
      {#if two}
        <div class="slot">{app.pageLabel}</div>
        <div style="flex:0 0 {gapPx}px"></div>
        <div class="slot">{rightNum}</div>
      {:else}
        <div class="slot">{app.pageLabel}</div>
      {/if}
    {/if}
  </div>

  {#if app.compatWarning && app.effectiveMode === 'chapter-spread'}
    <div class="banner" role="status">
      <span>{app.compatWarning}</span>
      <button class="btn" onclick={() => (app.compatWarning = null)}>Dismiss</button>
    </div>
  {/if}
</div>
