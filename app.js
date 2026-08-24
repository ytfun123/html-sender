/* Client-side .8xv (TI AppVar) builder - mirrors convbin output exactly.
 *
 * Layout (verified byte-for-byte against CEdev convbin):
 *   "**TI83F*" + 1A 0A 00 + comment(42 zeros)
 *   u16(13) | u16(r+2) | 0x15 | name(8,NUL-padded)
 *   u16(0) + u16(r+2) + u16(r)      <- fileioc prologue
 *   raw bytes
 *   u16 checksum of everything after the datalen field
 *
 * USB sending powered by ticalc.link's engine (ticalc-usb), vendored in
 * ./ticalclink.js exposing window.TICalcUsbLib = { ticalc, tifiles }.
 */

function concat(...arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

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

/* Sanitize HTML the same way the on-calc parser expects:
 * strip control chars except \n, map non-ASCII to '?' */
function sanitizeHtml(text) {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c === 10) out += "\n";
    else if (c < 32) { /* drop tabs/CR/controls */ }
    else if (c > 126) out += "?";
    else out += ch;
  }
  return out;
}

const MAX_HTML_BYTES = 200000; // keep pages comfortable for the calc's RAM

if (typeof document !== "undefined") {

const $ = (id) => document.getElementById(id);

let lastBlob = null;

$("file").addEventListener("change", async (e) => {
  await handleFiles(e.target.files);
});

/* drag & drop */
["dragover", "dragenter"].forEach((ev) =>
  document.body.addEventListener(ev, (e) => e.preventDefault())
);
document.body.addEventListener("drop", async (e) => {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files.length)
    await handleFiles(e.dataTransfer.files);
});

async function handleFiles(fileList) {
  const files = [...fileList].filter((f) =>
    /\.(html?|txt)$/i.test(f.name) || f.type === "text/html"
  );
  if (!files.length)
    return status("Drop .html / .htm / .txt files.");
  let slot = parseInt($("slot").value.slice(3), 10);
  const made = [];
  for (const f of files) {
    if (slot > 9) { status("Slots HTM0-HTM9 full - skipped " + f.name); break; }
    const text = sanitizeHtml(await f.text());
    if (!text.trim()) continue;
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > MAX_HTML_BYTES) {
      status(`Skipped ${f.name}: ${bytes.length} B is too big.`);
      continue;
    }
    const name = "HTM" + slot++;
    const data = build8xv(name, bytes);
    triggerDownload(data, name + ".8xv");
    made.push(name);
    await sleep(250); // browsers block multi-download bursts
  }
  if (made.length)
    status("Generated: " + made.join(", ") +
           ". Send them with the button below or TI Connect CE.");
}

function triggerDownload(bytes, filename) {
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

$("src").addEventListener("input", () => { /* kept for manual paste */ });

$("go").addEventListener("click", () => {
  const name = $("slot").value;
  const text = sanitizeHtml($("src").value);
  if (!text.trim()) {
    status("Paste, drop, or load some HTML first.");
    return;
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > MAX_HTML_BYTES) {
    status(`Too big: ${bytes.length} B. Keep pages under ${MAX_HTML_BYTES} B.`);
    return;
  }
  const data = build8xv(name, bytes);
  lastBlob = { name, data };
  triggerDownload(data, name + ".8xv");
  status(`OK: ${name}.8xv, ${data.length} bytes (${bytes.length} html). ` +
         "Use Send over USB, or download then TI Connect CE.");
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
    return status("Generate an .8xv first (button above).");
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
