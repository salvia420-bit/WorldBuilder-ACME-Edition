() => ({
  state: window.__bootState || null,
  url: location.href,
  hasLiveScene: !!window.liveScene3d,
  hasSessionHandle: !!(window.liveScene3d && window.liveScene3d.sessionHandle),
  hasPlayerGuid: (typeof window.getLocalPlayerGuid === "function")
    ? (window.getLocalPlayerGuid() || null) !== null
    : false,
})
