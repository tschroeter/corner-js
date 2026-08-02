<!-- The component the Svelte tab shows, compiled by bin/build.js and mounted for real by the live
     check on the page. It is the same file in both places, so the snippet cannot drift from what
     runs: if this stops working, the row says so. -->
<script>
    import { onMount } from 'svelte'

    let root

    onMount(() => cornerjs.apply(root))
</script>

<div bind:this={root} data-corner-shadow-wrap style="position: relative; width: 120px; height: 84px">
    <div data-corner-js class="framework-card">Svelte</div>
</div>
