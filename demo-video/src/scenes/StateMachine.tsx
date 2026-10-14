import { AbsoluteFill, Interactive, interpolate, useCurrentFrame } from "remotion";
import { colors, ease, font, mono } from "../theme";

const files = [".ai/PROJECT_STATE.json", "tasks/T-001.md", ".ai/AGENT_START_HERE.md"];
const states = [
  { label: "pending", color: colors.muted },
  { label: "in-progress", color: colors.blue },
  { label: "completed", color: colors.accent },
];

export const StateMachine: React.FC = () => {
  const frame = useCurrentFrame();
  const active = interpolate(frame, [70, 90, 105, 125], [0, 1, 1, 2], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill name="Background" style={{ background: colors.bg, fontFamily: font, padding: "100px 120px", gap: 60 }}>
      <Interactive.Div
        name="Heading"
        style={{
          fontSize: 88, fontWeight: 800, color: colors.text,
          opacity: interpolate(frame, [0, 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }),
        }}
      >
        State lives in Git
      </Interactive.Div>
      <div style={{ display: "flex", gap: 28 }}>
        {files.map((f, i) => (
          <Interactive.Div
            key={f}
            name={`File ${f}`}
            style={{
              fontFamily: mono, fontSize: 36, color: colors.accent, padding: "24px 32px",
              background: colors.panel, border: `2px solid ${colors.border}`, borderRadius: 18,
              opacity: interpolate(frame, [15 + i * 12, 30 + i * 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }),
              translate: interpolate(frame, [15 + i * 12, 30 + i * 12], ["0px 30px", "0px 0px"], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }),
            }}
          >
            {f}
          </Interactive.Div>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 40, marginTop: 40 }}>
        {states.map((s, i) => {
          const on = Math.abs(active - i) < 0.5;
          return (
            <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 40 }}>
              <Interactive.Div
                name={`State ${s.label}`}
                style={{
                  fontSize: 52, fontWeight: 700, padding: "30px 52px", borderRadius: 999,
                  color: on ? colors.bg : s.color, background: on ? s.color : colors.panel,
                  border: `3px solid ${s.color}`,
                  opacity: interpolate(frame, [55 + i * 6, 70 + i * 6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
                  scale: on ? 1.08 : 1,
                }}
              >
                {s.label}
              </Interactive.Div>
              {i < states.length - 1 && <div style={{ fontSize: 56, color: colors.muted }}>→</div>}
            </div>
          );
        })}
      </div>
      <Interactive.Div
        name="Caption"
        style={{
          fontSize: 44, color: colors.muted, textAlign: "center",
          opacity: interpolate(frame, [110, 130], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }),
        }}
      >
        Illegal transitions are rejected. Completion runs the task's Verify command.
      </Interactive.Div>
    </AbsoluteFill>
  );
};
