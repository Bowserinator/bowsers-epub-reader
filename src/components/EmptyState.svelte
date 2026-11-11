<script lang="ts">
  import { app } from '../app/app.svelte';
  import art from '../assets/empty-state.png';
</script>

<main class="welcome">
  <img class="art" src={art} alt="An open book" />
  <h1>No book open</h1>
  <p class="muted">Open an EPUB to start reading.</p>
  <button class="btn primary big" onclick={() => app.chooseBook()} data-autofocus>Open book</button>
  {#if app.openError}<p class="danger-text" role="alert">{app.openError}</p>{/if}
</main>

<style>
  .welcome { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; text-align: center; background: var(--bg); color: var(--fg); }
  .art { width: min(280px, 60vw); height: auto; }
  h1 { margin: 8px 0 0; font-size: 22px; font-weight: 600; }
  p { margin: 0; max-width: 42ch; }
  .big { min-height: 44px; padding: 0 28px; font-size: 15px; margin-top: 8px; }
</style>
