/* Original pixel scenery: transparent silhouettes, no remote art or animation loops. */
const scenery = (() => {
  const scenes = {
    meadow: ['Meadow', '#466d40', '#a4c768', '<path fill="#37724c" d="M10 44v-9h3v6h3v-11h3v14M74 44v-12h3v7h3v-4h3v9"/><path fill="#eeb4b0" d="M21 42v-3h3v-3h3v3h3v3h-3v3h-3v-3M70 49v-3h3v-3h3v3h3v3h-3v3h-3v-3"/><path fill="#f7de8e" d="M24 39h3v3h-3M73 46h3v3h-3"/>'],
    forest: ['Pine grove', '#304c3e', '#6f9856', '<path fill="#79523b" d="M13 19h5v30h-5M78 24h4v26h-4"/><path fill="#244f43" d="M7 35h18v-5h-3v-6h-3v-7h-6v7h-3v6H7M73 39h16v-5h-3v-6h-4v-7h-4v7h-3v6h-2"/><path fill="#50895b" d="M10 29h12v3H10M76 33h10v3H76"/><path fill="#d8986f" d="M27 48h8v3h-8M29 45h4v3h-4"/>'],
    pond: ['Lily pond', '#355d60', '#71afa8', '<path fill="#438da0" d="M19 40h56v3h9v8h-9v4H23v-3H12v-8h7"/><path fill="#a6dadd" d="M19 45h16v2H19M57 51h16v2H57"/><path fill="#4d804b" d="M18 47h13v6H18M71 42h12v7H71"/><path fill="#eeb9d1" d="M21 44h6v5h-6M74 39h6v5h-6"/><path fill="#66773c" d="M7 46V29h2v17M11 44V25h2v19"/><path fill="#a97b45" d="M6 27h4v8H6M10 23h4v7h-4"/>'],
    beach: ['Tide pool', '#9e825b', '#e9cf91', '<path fill="#71bac3" d="M55 41h24v3h9v9h-9v4H46v-3h9"/><path fill="#deeee1" d="M55 44h23v3H55M50 52h16v2H50"/><path fill="#9b6f43" d="M13 22h4v29h-4"/><path fill="#4d915c" d="M5 21h8v-4h8v4h8v5H17v5h-4v-5H5"/><path fill="#e49479" d="M28 48h7v4h-7M30 46h3v2h-3"/>'],
    snow: ['Snowdrift', '#839eaa', '#dde9df', '<path fill="#66878a" d="M9 41h18v-5h-3v-7h-3v-6h-6v6h-3v7H9M72 45h14v-6h-3v-8h-7v8h-4"/><path fill="#f2f4e8" d="M12 36h12v3H12M15 29h6v3h-6M74 39h10v3H74"/><path fill="#b6d1d1" d="M18 52h20v3H18M64 48h11v3H64"/><path fill="#eaf4e6" d="M29 19h3v3h-3M70 14h3v3h-3M84 24h3v3h-3"/>'],
    ruins: ['Old ruins', '#595a51', '#a1ad86', '<path fill="#7e897c" d="M10 25h13v26H10M72 20h14v32H72"/><path fill="#b3b99d" d="M8 22h17v5H8M70 17h18v5H70M9 47h16v5H9M70 48h18v5H70"/><path fill="#505f58" d="M15 28h3v12h-3M77 24h3v15h-3M74 41h10v3H74"/><path fill="#678751" d="M9 39h7v4H9M69 44h8v4h-8M33 53h6v3h-6"/>'],
    camp: ['Camp clearing', '#5d5940', '#a5ad71', '<path fill="#c28957" d="M6 44v-4h4v-6h4v-7h4v-5h3v5h4v7h4v6h4v8H6"/><path fill="#edbd7e" d="M19 27h3v6h4v7h4v6H19"/><path fill="#493c37" d="M16 39h6v9h-6"/><path fill="#785340" d="M69 51h15v3H69M72 48h3v9h-3M79 48h3v9h-3"/><path fill="#e89453" d="M73 48v-5h3v-8h3v8h3v5"/><path fill="#f4d080" d="M76 44h3v6h-3"/>'],
    volcano: ['Warm crater', '#443f46', '#7f7272', '<path fill="#63535a" d="M5 42h5v-8h4v-6h8v6h4v8h5v9H5M70 45h5V31h4v-8h6v8h4v14"/><path fill="#cf754d" d="M18 48h14v3h8v4h18v-3h8v-3h15v5H68v4H38v-3H18"/><path fill="#eabd72" d="M39 53h16v2H39M69 50h9v2h-9"/><path fill="#bb6252" d="M14 26h8v4h-8M78 21h8v4h-8"/>'],
  };
  function svg(name) {
    const scene = scenes[name];
    if (!scene) return '';
    return `<svg class="scenery" data-scene="${name}" viewBox="0 0 96 64" aria-hidden="true" shape-rendering="crispEdges"><path fill="${scene[1]}" d="M18 40h60v4h10v12H78v4H18v-4H8V44h10z"/><path fill="${scene[2]}" d="M18 38h60v4h10v9H78v4H18v-4H8v-9h10z"/>${scene[3]}</svg>`;
  }
  return { svg, choices: Object.entries(scenes).map(([id, scene]) => ({ id, label: scene[0] })) };
})();
