<script lang="ts">
  import { app } from '../app/app.svelte';
  import { onBackdrop, trap } from '../app/actions';
  const rows: [string, string][] = [
    ['← / →', 'Previous / next page (reversed for right-to-left books)'], ['Space / Shift+Space', 'Next / previous page'],
    ['PageDown / PageUp', 'Next / previous page'], ['Mouse wheel', 'Next / previous page (paged modes)'],
    ['Home / End', 'Start / end of book'], ['Ctrl+F', 'Search'],
    ['Ctrl+,', 'Settings'], ['Ctrl+B', 'Bookmark this page'], ['Ctrl+Z', 'Undo the last bookmark or highlight change'], ['Click page edge', 'Previous / next page (left half / right half of the page area)'], ['Ctrl+= / Ctrl+- / Ctrl+0', 'Font size up / down / reset'],
    ['Ctrl+G', 'Go to page'], ['Ctrl+H', 'Toggle auto-hide toolbars'], ['Alt+← / Alt+→', 'Back / forward in reading history'],
    ['Esc', 'Close popup, dialog or panel'], ['?', 'This list']
  ];
</script>

<div class="overlay" role="presentation" onpointerdown={onBackdrop(() => (app.shortcutsOpen = false))}>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="sc-h" use:trap>
    <h2 id="sc-h">Keyboard shortcuts</h2>
    <table>
      <tbody>{#each rows as [k, d]}<tr><th scope="row"><kbd>{k}</kbd></th><td>{d}</td></tr>{/each}</tbody>
    </table>
    <div style="text-align:right;margin-top:16px"><button class="btn primary" data-autofocus onclick={() => (app.shortcutsOpen = false)}>Close</button></div>
  </div>
</div>

<style>
  table { border-collapse: collapse; } th { text-align: left; padding: 4px 16px 4px 0; font-weight: 500; white-space: nowrap; } td { padding: 4px 0; color: var(--muted); }
  kbd { font-family: inherit; background: var(--chrome); border: 1px solid var(--border); border-radius: var(--radius); padding: 1px 6px; }
</style>
