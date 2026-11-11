<script lang="ts">
  import { app } from '../app/app.svelte';
  import { chapterIndexAt } from '../reader/locations';
  import { clamp } from '../app/format';
  import { AutoHide } from '../app/autohide.svelte';
  import { POPUP_MARGIN } from '../app/actions';

  let track: HTMLDivElement;
  let wrap: HTMLDivElement;
  let tipW = $state(0);
  let drag = $state<number | null>(null);
  let hoverPct = $state<number | null>(null);
  let keyTimer: number | undefined;
  const hide = new AutoHide();
  const hidden = $derived(hide.hidden(app.effective.autoHideControls));

  const shown = $derived(drag ?? app.pinnedPercent ?? app.percent);
  const chapters = $derived(app.model?.chapters ?? []);
  const hoverChapter = $derived.by(() => {
    if (hoverPct === null || !app.model) return null;
    const i = chapterIndexAt(app.model, hoverPct);
    return i >= 0 ? app.model.chapters[i] : null;
  });
  const CARET_INSET = 8;
  /** Tooltip box offset within the slider wrapper, kept on screen, and the caret offset inside the box. */
  const tipPos = $derived.by(() => {
    if (hoverPct === null || !wrap) return { left: 0, caret: 0 };
    const r = wrap.getBoundingClientRect();
    const center = r.left + hoverPct * r.width;
    const boxLeft = clamp(center - tipW / 2, POPUP_MARGIN, Math.max(POPUP_MARGIN, window.innerWidth - tipW - POPUP_MARGIN));
    return { left: boxLeft - r.left, caret: clamp(center - boxLeft, CARET_INSET, Math.max(CARET_INSET, tipW - CARET_INSET)) };
  });
  const valueText = $derived(`${app.chapterTitle ? app.chapterTitle + ', ' : ''}${Math.round(shown * 100)} percent${app.pageLabel ? ', page ' + app.pageLabel : ''}`);

  function pctFromEvent(e: PointerEvent | MouseEvent) {
    const r = track.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  }
  function down(e: PointerEvent) { track.setPointerCapture(e.pointerId); app.beginScrub(); drag = pctFromEvent(e); app.scrub(drag); }
  function move(e: PointerEvent) { hoverPct = pctFromEvent(e); if (drag !== null) { drag = hoverPct; app.scrub(drag); } }
  function finishDrag(p: number) {
    if (drag === null) return;
    drag = null;
    app.endScrub(p);
    track.blur();
  }
  function key(e: KeyboardEvent) {
    const step = e.shiftKey ? 0.1 : 0.01;
    let p = shown;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') p += step;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') p -= step;
    else if (e.key === 'PageUp' || e.key === 'PageDown') {
      const m = app.model; if (!m) return;
      const i = chapterIndexAt(m, shown);
      const j = clamp(i + (e.key === 'PageDown' ? 1 : -1), 0, m.chapters.length - 1);
      p = m.chapters[j]?.startPct ?? p;
    } else if (e.key === 'Home') p = 0;
    else if (e.key === 'End') p = 0.9999;
    else return;
    e.preventDefault(); e.stopPropagation();
    drag = clamp(p, 0, 1);
    if (keyTimer) clearTimeout(keyTimer);
    keyTimer = window.setTimeout(() => { const v = drag; drag = null; if (v !== null) app.goToPercent(v); }, 350);
  }
</script>

<footer class="bar bottom" class:hidden onpointerleave={() => { hoverPct = null; hide.leave(); }}
  onfocusin={hide.focusIn} onfocusout={hide.focusOut}>
  <div class="zone" onpointerenter={hide.enter} aria-hidden="true"></div>
  <div class="content" onpointerenter={hide.enter}>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="sliderwrap" bind:this={wrap}>
      {#if hoverChapter && hoverPct !== null}
        <div class="tip" style="left:{tipPos.left}px" role="tooltip" bind:clientWidth={tipW}>
          <span class="tt">{hoverChapter.title}</span><span class="caret" style="left:{tipPos.caret}px"></span>
        </div>
      {/if}
      <div bind:this={track} class="track" role="slider" tabindex="0" aria-label="Book progress" aria-valuemin="0" aria-valuemax="100"
        aria-valuenow={Math.round(shown * 100)} aria-valuetext={valueText}
        onpointerdown={down} onpointermove={move} onpointerup={(e) => finishDrag(pctFromEvent(e))} onpointercancel={() => finishDrag(drag ?? shown)} onkeydown={key}>
        <div class="rail"></div>
        <div class="fill" style="width:{shown * 100}%"></div>
        {#each chapters as c}
          <span class="chtick" style="left:{c.startPct * 100}%"></span>
        {/each}
        <div class="thumb" style="left:{shown * 100}%"></div>
      </div>
    </div>
    <div class="meta">
      <span class="muted left">
        {#if app.pageLabel}
          <span title={app.pageScheme === 'EPUB' ? 'Page labels from the book’s own page list' : 'Counted from the current layout'}>Page {app.pageLabel}{app.totalPagesLabel ? `/${app.totalPagesLabel}` : ''}</span>
          ·
        {/if}
        {Math.round(shown * 100)}%
      </span>
      <span class="center" title={app.chapterTitle}>{app.chapterTitle}</span>
      <span class="muted right" role="button" tabindex="0" title="{app.effective.remainingMode === 'chapter-pages' ? 'Click to change' : `Estimate at ${app.effective.readingSpeedWpm} words per minute. Click to change`}"
        onclick={() => app.cycleRemainingMode()}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); app.cycleRemainingMode(); } }}>{app.remaining}</span>
    </div>
  </div>
</footer>

<style>
  .content { position: relative; }
  .sliderwrap { position: relative; padding-top: 6px; }
  .track { position: relative; height: 22px; cursor: pointer; touch-action: none; border-radius: 0; }
  .rail { position: absolute; left: 0; right: 0; top: 9px; height: 4px; background: var(--border); border-radius: 2px; }
  .fill { position: absolute; left: 0; top: 9px; height: 4px; background: var(--accent); border-radius: 2px; }
  .chtick { position: absolute; top: 8px; width: 2px; height: 6px; margin-left: -1px; background: var(--muted); opacity: .6; border-radius: 1px; }
  .thumb { position: absolute; top: 4px; width: 14px; height: 14px; margin-left: -7px; border-radius: 50%; background: var(--accent); border: 2px solid var(--bg); box-shadow: 0 0 0 1px var(--accent); }
  .tip { position: absolute; bottom: 100%; margin-bottom: 4px; max-width: calc(100vw - 16px); padding: 4px 8px; font-size: 12px; background: var(--fg); color: var(--bg); border-radius: 0; white-space: nowrap; z-index: 20; pointer-events: none; }
  .tt { display: block; overflow: hidden; text-overflow: ellipsis; }
  .caret { position: absolute; top: 100%; margin-left: -5px; border: 5px solid transparent; border-top-color: var(--fg); border-bottom: 0; }
  .meta { display: grid; grid-template-columns: 1fr minmax(0, 2fr) 1fr; gap: 12px; font-size: 12px; align-items: center; }
  .center { text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .right { text-align: right; cursor: pointer; }
</style>
