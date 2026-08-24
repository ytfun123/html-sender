/* Client-side .8xv (TI AppVar) builder - mirrors convbin output exactly.
 *
 * Layout (verified byte-for-byte against CEdev convbin):
 *   "**TI83F*" + 1A 0A 00 + comment(42 zeros)
 *   u16(13) | u16(r+2) | 0x15 | name(8,NUL-padded)
 *   u16(0) + u16(r+2) + u16(r)      <- fileioc prologue
 *   raw bytes
 *   u16 checksum of everything after the datalen field
 *
 * ticalc.link integration: drop your ticalc.link source next to this file
 * as ./ticalclink.js and expose window.TICalcLink.sendFile(name, uint8array).
 * The Send button below picks it up automatically, no other changes needed.
 */

function u16(v) {
  return new Uint8Array([v & 255, (v >> 8) & 255]);
}

function ascii(s) {
  return Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
}

function build8xv(name, bytes) {
  const r = bytes.length;
  const out = [];
  const body = [];

  out.push(ascii("**TI83F*"), new Uint8Array([0x1a, 0x0a, 0x00]));
  out.push(new Uint8Array(42)); // comment field

  body.push(u16(13), u16(r + 2), new Uint8Array([0x15])); // AppVar type
  {
    let n = ascii(name).slice(0, 8);
    while (n.length < 8) n = concat(n, new Uint8Array([0]));
    body.push(n);
  }
  body.push(u16(0), u16(r + 2), u16(r)); // fileioc prologue
  body.push(bytes);

  const bodyLen = body.reduce((s, p) => s + p.length, 0);
  for (const p of body) out.push(p);
  out.splice(3, 0, u16(bodyLen)); // datalen goes right after the 55-byte header

  let sum = 0;
  for (const p of body) for (const b of p) sum += b;
  out.push(u16(sum & 0xffff));
  return concat(...out);
}

function concat(...arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

const $ = (id) => document.getElementById(id);

if (typeof document !== "undefined") {

$("file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  $("src").value = await f.text();
});

let lastBlob = null;

$("go").addEventListener("click", () => {
  const name = $("slot").value;
  const text = $("src").value;
  if (!text.trim()) {
    status("Paste or load some HTML first.");
    return;
  }
  const bytes = new TextEncoder().encode(text); // calc folds >127 to '?'
  const data = build8xv(name, bytes);
  lastBlob = { name, data };
  const blob = new Blob([data], { type: "application/octet-stream" });
  const dl = $("dl");
  dl.href = URL.createObjectURL(blob);
  dl.download = name + ".8xv";
  dl.style.display = "inline";
  status(`OK: ${name}.8xv, ${data.length} bytes (${bytes.length} html).`);
});

/* ---- real USB sending via ticalc.link's engine (ticalc-usb) ---- */

let usbCalc = null;

if (window.TICalcUsbLib && navigator.usb) {
  const { ticalc } = window.TICalcUsbLib;
  ticalc.init({ supportLevel: "none" }).catch(() => {});
  ticalc.addEventListener("connect", async (calc) => {
    try {
      if (await calc.isReady()) {
        usbCalc = calc;
        status("Connected: " + calc.name);
      }
    } catch (e) {
      status("Device did not respond.");
    }
  });
  ticalc.addEventListener("disconnect", () => {
    usbCalc = null;
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

$("send").addEventListener("click", async () => {
  if (!lastBlob)
    return status("Generate the .8xv first.");
  if (!window.TICalcUsbLib || !navigator.usb)
    return status("WebUSB not available - use Chrome/Edge on desktop, or download the .8xv.");

  const { ticalc, tifiles } = window.TICalcUsbLib;
  try {
    if (!usbCalc) {
      status("Choose your calculator in the browser prompt...");
      await ticalc.choose(); // fires 'connect' above
      for (let i = 0; i < 50 && !usbCalc; i++)
        await sleep(100);
    }
    if (!usbCalc)
      return status("No calculator connected.");

    const file = tifiles.parseFile(lastBlob.data);
    if (!tifiles.isValid(file))
      return status("Generated file failed validation?!");
    if (!usbCalc.canReceive(file))
      return status(usbCalc.name + " cannot receive this file type.");

    const details = await usbCalc.getStorageDetails(file);
    if (details && details.fits === false)
      return status("Not enough free memory on the calculator.");

    status("Sending " + lastBlob.name + "...");
    await usbCalc.sendFile(file);
    status("Sent! Open HTMLREAD on the calc and pick " + lastBlob.name + ".");
  } catch (err) {
    status("USB send failed: " + (err.message || err));
  }
});

function status(msg) {
  $("status").textContent = msg;
}

} // end browser-only UI block

