// Turns MusicXML into a compact, bar-by-bar text list for the AI to check against the page
// image, e.g. "m3 P1: E4/q G4/8. A4/16 | rest/h". No XML parser needed: MusicXML is regular.

const FIFTHS = { "-7": "7♭", "-6": "6♭", "-5": "5♭", "-4": "4♭", "-3": "3♭", "-2": "2♭", "-1": "1♭", 0: "no sharps/flats", 1: "1♯", 2: "2♯", 3: "3♯", 4: "4♯", 5: "5♯", 6: "6♯", 7: "7♯" };
const TYPE = { whole: "w", half: "h", quarter: "q", eighth: "8", "16th": "16", "32nd": "32", "64th": "64", breve: "breve" };

const tag = (xml, name) => new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];
const all = (xml, name) => [...xml.matchAll(new RegExp(`<${name}(\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${name}>)`, "g"))];

/**
 * @param {string[]} xmls  score pieces in playing order (bars continue across pieces)
 * @returns {{ text: string, measures: number }}
 */
export function summarizeScore(xmls) {
  const lines = [];
  let offset = 0;
  let total = 0;
  xmls.forEach((xml, pieceIndex) => {
    const names = Object.fromEntries(all(xml, "score-part").map((m) => [/id="([^"]+)"/.exec(m[1] ?? "")?.[1], tag(m[2] ?? "", "part-name")?.trim() || "Part"]));
    let pieceBars = 0;
    all(xml, "part").forEach((partMatch, partIndex) => {
      const id = /id="([^"]+)"/.exec(partMatch[1] ?? "")?.[1];
      let clefs = "";
      all(partMatch[2] ?? "", "measure").forEach((m, i) => {
        const body = m[2] ?? "";
        const bar = offset + i + 1;
        const head = [];
        const attrs = tag(body, "attributes");
        if (attrs) {
          const fifths = tag(attrs, "fifths");
          if (fifths !== undefined) head.push(`key ${FIFTHS[fifths.trim()] ?? fifths}`);
          const beats = tag(attrs, "beats");
          const type = tag(attrs, "beat-type");
          if (beats) head.push(`time ${beats}/${type}`);
          const c = all(attrs, "clef").map((cm) => `${tag(cm[2] ?? "", "sign")}${tag(cm[2] ?? "", "line") ?? ""}`).join("+");
          if (c && c !== clefs) {
            clefs = c;
            head.push(`clef ${c.replace("G2", "treble").replace("F4", "bass")}`);
          }
        }
        if (/<print[^>]*new-page="yes"/.test(body)) head.push("new page");
        else if (/<print[^>]*new-system="yes"/.test(body)) head.push("new line");
        const events = [];
        for (const n of all(body, "note")) {
          const note = n[2] ?? "";
          if (/<grace/.test(note)) continue;
          const chord = /<chord\s*\/>/.test(note);
          const type = TYPE[tag(note, "type")?.trim() ?? ""] ?? "?";
          const dots = (note.match(/<dot\s*\/>/g) ?? []).length;
          const staff = tag(note, "staff");
          let what;
          if (/<rest/.test(note)) what = /measure="yes"/.test(note) ? "bar-rest" : `rest/${type}`;
          else {
            const step = tag(note, "step");
            const alter = Number(tag(note, "alter") ?? 0);
            const octave = tag(note, "octave");
            what = `${step}${alter > 0 ? "#".repeat(alter) : "b".repeat(-alter)}${octave}/${type}${".".repeat(dots)}`;
            if (/<tie[^>]*type="start"/.test(note)) what += "~";
          }
          const label = (staff && staff !== "1" ? `s${staff}:` : "") + what;
          if (chord && events.length) events[events.length - 1] += `+${label.replace(/\/.*$/, "")}`;
          else events.push(label);
        }
        lines.push(`m${bar} P${partIndex + 1}(${names[id] ?? "Part"})${head.length ? ` [${head.join(", ")}]` : ""}: ${events.join(" ") || "(empty)"}`);
        pieceBars = Math.max(pieceBars, i + 1);
      });
    });
    offset += pieceBars;
    total = offset;
    if (pieceIndex < xmls.length - 1) lines.push("--- (continues) ---");
  });
  return { text: lines.join("\n"), measures: total };
}
