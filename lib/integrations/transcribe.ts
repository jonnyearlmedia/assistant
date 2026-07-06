// voice-note transcription (Tomo's "voice ingestion" pillar, done the way that fits lexa).
// Linq delivers a voice memo as an audio media part (a URL). we fetch the bytes (with Linq auth),
// run them through Deepgram → text, and that transcript then flows into think() exactly like a
// typed message would. GATED on DEEPGRAM_API_KEY: no key → this is a no-op and audio falls back
// to the "couldn't open it" path, so nothing breaks until jonny drops a key in.
const AUDIO_RE = /^audio\/|^application\/(ogg|octet-stream)$/;

export function transcriptionEnabled(): boolean {
  return !!process.env.DEEPGRAM_API_KEY;
}

// fetch an inbound media URL and, IF it's audio, return the transcript. returns null for
// non-audio, when transcription isn't configured, or on any failure (caller degrades gracefully).
export async function transcribeAudioUrl(url: string): Promise<string | null> {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return null;
  try {
    const src = await fetch(url, {
      headers: process.env.LINQ_API_KEY ? { Authorization: `Bearer ${process.env.LINQ_API_KEY}` } : {},
    });
    if (!src.ok) return null;
    const ct = (src.headers.get("content-type") || "").split(";")[0].trim();
    if (!AUDIO_RE.test(ct)) return null; // not audio — let the image / text handlers take it
    const buf = Buffer.from(await src.arrayBuffer());
    if (buf.length > 25_000_000) return null; // 25MB cap — a voice memo is tiny; this is a guard

    const dg = await fetch(
      "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true",
      { method: "POST", headers: { Authorization: `Token ${key}`, "Content-Type": ct }, body: buf }
    );
    if (!dg.ok) {
      console.error("[lexa] deepgram transcribe failed:", dg.status, (await dg.text()).slice(0, 200));
      return null;
    }
    const d = await dg.json().catch(() => null);
    const text: string | undefined = d?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
    return text && text.trim() ? text.trim() : null;
  } catch (e: any) {
    console.error("[lexa] transcribe error:", e?.message || e);
    return null;
  }
}
