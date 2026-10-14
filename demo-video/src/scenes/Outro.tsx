import { AbsoluteFill, Interactive, interpolate, useCurrentFrame } from "remotion";
import { colors, ease, font, mono } from "../theme";

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill name="Background" style={{ background: colors.bg, fontFamily: font, justifyContent: "center", alignItems: "center", gap: 40 }}>
      <Interactive.Div
        name="Title"
        style={{
          fontSize: 110, fontWeight: 800, color: colors.text,
          opacity: interpolate(frame, [0, 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }),
        }}
      >
        Try it now
      </Interactive.Div>
      <Interactive.Div
        name="Command"
        style={{
          fontFamily: mono, fontSize: 40, color: colors.accent, padding: "28px 44px",
          background: colors.panel, border: `2px solid ${colors.border}`, borderRadius: 20,
          opacity: interpolate(frame, [20, 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }),
        }}
      >
        npx github:three-fourteen/ai-agent-workflow-demo init my-project
      </Interactive.Div>
    </AbsoluteFill>
  );
};
