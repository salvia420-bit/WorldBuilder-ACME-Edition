// Top-right compass/radar disk.
//
// Direct port of retail gmRadarUI (layout 0x21000074) using real DAT
// sprites extracted 2026-05-22:
//   - 0x06004CC1 = compass disk 48x48 (brass-rimmed dark interior + dark
//                  vertical north-wedge indicator)
//   - 0x060011FB = green "N" letter
//   - 0x06001938 = green "E" letter
//   - 0x0600193A = green "S" letter
//   - 0x0600193C = green "W" letter
//   - 0x060074C9 = brass compass-rose cross (centre marker)
//
// First pass: static compass (no rotation by player heading, no entity
// blips). Hooking pose.heading and entity radar dots is a follow-on.

const OVERLAY_ID = "hb-radar";
const DISK_SIZE = 48;

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-radar-style";
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      top: 8px;
      right: 8px;
      z-index: 50;
      width: ${DISK_SIZE}px;
      height: ${DISK_SIZE}px;
      pointer-events: none;
      font-family: var(--hb-font-serif);
      background: url("./data/ui-sprites/0x06004CC1.png") center/100% 100% no-repeat;
    }
    #${OVERLAY_ID} .hb-radar-cardinal {
      position: absolute;
      width: 8px;
      height: 8px;
      background-repeat: no-repeat;
      background-size: contain;
      background-position: center;
      filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.6));
    }
    #${OVERLAY_ID} .hb-radar-n { top: 1px;  left: 50%; transform: translateX(-50%);
                                background-image: url("./data/ui-sprites/0x060011FB.png"); }
    #${OVERLAY_ID} .hb-radar-e { right: 1px; top: 50%; transform: translateY(-50%);
                                background-image: url("./data/ui-sprites/0x06001938.png"); }
    #${OVERLAY_ID} .hb-radar-s { bottom: 1px; left: 50%; transform: translateX(-50%);
                                background-image: url("./data/ui-sprites/0x0600193A.png"); }
    #${OVERLAY_ID} .hb-radar-w { left: 1px;  top: 50%; transform: translateY(-50%);
                                background-image: url("./data/ui-sprites/0x0600193C.png"); }
    #${OVERLAY_ID} .hb-radar-centre {
      position: absolute;
      top: 50%; left: 50%;
      width: 10px;
      height: 10px;
      transform: translate(-50%, -50%);
      background: url("./data/ui-sprites/0x060074C9.png") center/contain no-repeat;
      filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.6));
    }
  `;
  document.head.appendChild(style);
}

export const manifest = {
  id: "radar",
  name: "Compass",
  // No bar icon — the radar IS the presentation. iconHidden so it
  // claims no bar real-estate but still runs through mount().
  icon: "🧭",
  iconHidden: true,
  version: "0.1.0",
  description: "Top-right compass/radar disk (retail gmRadarUI 0x21000074)",
};

export function mount(_ctx) {
  ensureStyles();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  for (const dir of ["n", "e", "s", "w"]) {
    const card = document.createElement("div");
    card.className = `hb-radar-cardinal hb-radar-${dir}`;
    overlay.appendChild(card);
  }
  const centre = document.createElement("div");
  centre.className = "hb-radar-centre";
  overlay.appendChild(centre);

  document.body.appendChild(overlay);

  return () => {
    overlay.remove();
  };
}
