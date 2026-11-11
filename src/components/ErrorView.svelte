<script lang="ts">
  import { app } from '../app/app.svelte';
</script>

<main class="err" role="alert">
  <h1>This book could not be opened</h1>
  <p>{app.error}</p>
  <button class="btn primary" onclick={() => { app.error = null; app.phase = 'empty'; }}>Back</button>
</main>

<style>
  .err { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; text-align: center; }
  h1 { font-size: 20px; margin: 0; }
  p { max-width: 60ch; color: var(--muted); margin: 0; }
</style>
