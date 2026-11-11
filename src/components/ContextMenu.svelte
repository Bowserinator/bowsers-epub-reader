<script lang="ts">
  import { app } from '../app/app.svelte';
  import { placeAtPoint } from '../app/actions';
  import { HIGHLIGHT_COLORS } from '../reader/ReaderEngine';

  const menu = $derived(app.contextMenu!);
  let w = $state(0), h = $state(0);
  const pos = $derived(placeAtPoint(menu.x, menu.y, w, h));
</script>

<div class="popover ctx" role="menu" aria-label="Text actions" bind:offsetWidth={w} bind:offsetHeight={h}
  style="left:{pos.left}px;top:{pos.top}px;visibility:{h ? 'visible' : 'hidden'}" onpointerdown={(e) => e.preventDefault()}>
  <div class="colors">
    {#each Object.entries(HIGHLIGHT_COLORS) as [name, hex]}
      <button class="dot" style="background:{hex}" title="Highlight {name}" aria-label="Highlight {name}" onclick={() => app.applyHighlight(name)}></button>
    {/each}
    <button class="x" title="Remove highlight" aria-label="Remove highlight" onclick={() => app.clearHighlight()}>×</button>
  </div>
  <button class="item" role="menuitem" onclick={() => app.copySelection()}>Copy text</button>
  <button class="item" role="menuitem" onclick={() => app.searchSelection()}>Search in book</button>
  {#if app.selectionDef}<button class="item" role="menuitem" onclick={() => app.defineSelection()}>Define</button>{/if}
</div>

<style>
  .ctx { display: flex; flex-direction: column; min-width: 170px; padding: 4px 0; }
  .colors { display: flex; align-items: center; gap: 6px; padding: 6px 12px 8px; border-bottom: 1px solid var(--border); margin-bottom: 4px; }
  .dot { width: 19px; height: 19px; border-radius: 50%; border: 2px solid var(--bg); box-shadow: 0 0 0 1px var(--border); padding: 0; }
  .x { width: 22px; height: 22px; border: 1px solid var(--border); border-radius: 50%; background: transparent; font-size: 14px; line-height: 1; padding: 0; }
  .item { text-align: left; border: 0; background: transparent; padding: 0 12px; min-height: 32px; border-radius: 0; }
  .item:hover { background: var(--hover); }
</style>
