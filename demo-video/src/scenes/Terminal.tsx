import { AbsoluteFill, Interactive, interpolate, useCurrentFrame } from "remotion";
import { colors, ease, font, mono } from "../theme";

const lines = [
  { cmd: "agent-workflow next", out: "T-001  Setup project   (runnable)", at: 15 },
  { cmd: "agent-workflow task start T-001", out: "T-001 pending → in-progress", at: 65 },
  { cmd: "agent-workflow task complete T-001", out: "✓ Verify passed · T-001 completed", at: 115 },
  { cmd: "agent-workflow validate", out: "✓ state and task graph are valid", at: 155 },
];

export const Terminal: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill name="Background" style={{ background: colors.bg, fontFamily: font, justifyContent: "center", alignItems: "center" }}>
      <Interactive.Div
        name="Terminal"
        style={{
          width: 1560, padding: "56px 64px", background: colors.panel, border: `2px solid ${colors.border}`,
          borderRadius: 28, fontFamily: mono, fontSize: 40, display: "flex", flexDirection: "column", gap: 34,
          opacity: interpolate(frame, [0, 15], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }),
        }}
      >
        {lines.map((l) => {
          const typed = Math.floor(interpolate(frame, [l.at, l.at + 25], [0, l.cmd.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
          const showOut = frame >= l.at + 28;
          return (
            <div key={l.cmd} style={{ opacity: frame >= l.at ? 1 : 0 }}>
              <div style={{ color: colors.text }}>
                <span style={{ color: colors.accent }}>$ </span>
                {l.cmd.slice(0, typed)}
              </div>
              <div style={{ color: colors.blue, marginTop: 10, opacity: showOut ? 1 : 0 }}>{l.out}</div>
            </div>
          );
        })}
      </Interactive.Div>
    </AbsoluteFill>
  );
};
