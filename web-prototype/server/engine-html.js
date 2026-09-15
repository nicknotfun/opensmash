const CONTROLLER_REMAP_TAG = '<script src="/controller-remap.js"></script>';
const NETPLAY_TAG = '<script src="/ssb64-netplay.js"></script>';
const NETPLAY_INSTALL = '<script>(function(){let session;try{session=parent!==window&&parent.openSmashNetplay;}catch{return;}if(!session)return;if(typeof Module!=="undefined"&&window.openSmashSsb64Netplay){window.openSmashSsb64Netplay.install(Module,()=>ENV);return;}const fail=()=>session.fail(new Error("The Smash 64 multiplayer bridge could not load."));if(typeof Module!=="undefined")Module.onRuntimeInitialized=fail;fail();})();</script>';

export function withControllerRemap(html) {
  const source = String(html || "");
  let result = source;
  if (!result.includes(CONTROLLER_REMAP_TAG)) {
    result = result.includes("</head>")
      ? result.replace("</head>", `  ${CONTROLLER_REMAP_TAG}\n</head>`)
      : `${CONTROLLER_REMAP_TAG}\n${result}`;
  }
  return withSsb64Netplay(result);
}

export function withSsb64Netplay(html) {
  let source = String(html || "");
  if (!source.includes(NETPLAY_TAG)) {
    source = source.includes("</head>")
      ? source.replace("</head>", `  ${NETPLAY_TAG}\n</head>`)
      : `${NETPLAY_TAG}\n${source}`;
  }
  if (source.includes(NETPLAY_INSTALL)) return source;
  // BattleShip inserts its wasm script asynchronously after archive preparation.
  // The final inline script installs the lifecycle hook in the same parser turn.
  if (source.includes("</body>")) return source.replace("</body>", `${NETPLAY_INSTALL}\n</body>`);
  return `${source}\n${NETPLAY_INSTALL}`;
}
