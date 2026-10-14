import { AbsoluteFill, Interactive, interpolate, useCurrentFrame } from "remotion";
import { colors, ease, font } from "../theme";

const cards = [
  { name: "social-feed", desc: "Threads-style feed UI" },
  { name: "dashboard", desc: "Analytics charts and mock API" },
  { name: "mini-saas", desc: "Landing, signup, fake auth" },
  { name: "bookmarks", desc: "Real CLI built through MCP tools" },
];

export const Projects: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill name="Background" style={{ background: colors.bg, fontFamily: font, padding: "100px 120px", gap: 60 }}>
      <Interactive.Div
        name="Heading"
        style={{
          fontSize: 88, fontWeight: 800, color: colors.text,
          opacity: interpolate(frame, [0, 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }),
        }}
      >
        One workflow, many agents and projects
      </Interactive.Div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 36 }}>
        {cards.map((c, i) => (
          <Interactive.Div
            key={c.name}
            name={`Card ${c.name}`}
            style={{
              padding: "40px 48px", background: colors.panel, border: `2px solid ${colors.border}`, borderRadius: 24,
              opacity: interpolate(frame, [15 + i * 10, 35 + i * 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }),
              translate: interpolate(frame, [15 + i * 10, 35 + i * 10], ["0px 40px", "0px 0px"], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }),
            }}
          >
            <div style={{ fontSize: 56, fontWeight: 700, color: colors.accent }}>{c.name}</div>
            <div style={{ fontSize: 40, color: colors.muted, marginTop: 12 }}>{c.desc}</div>
          </Interactive.Div>
        ))}
      </div>
      <Interactive.Div
        name="MCP"
        style={{
          fontSize: 48, color: colors.blue,
          opacity: interpolate(frame, [70, 90], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }),
        }}
      >
        Claude → Gemini → Codex, relayed through the repo (CLI + MCP server)
      </Interactive.Div>
    </AbsoluteFill>
  );
};
