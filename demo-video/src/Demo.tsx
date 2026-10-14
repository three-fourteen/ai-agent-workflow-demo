import { Series } from "remotion";
import { Intro } from "./scenes/Intro";
import { Problem } from "./scenes/Problem";
import { StateMachine } from "./scenes/StateMachine";
import { Terminal } from "./scenes/Terminal";
import { Projects } from "./scenes/Projects";
import { Outro } from "./scenes/Outro";

export const Demo: React.FC = () => (
  <Series>
    <Series.Sequence name="Intro" durationInFrames={90}><Intro /></Series.Sequence>
    <Series.Sequence name="Problem" durationInFrames={120}><Problem /></Series.Sequence>
    <Series.Sequence name="StateMachine" durationInFrames={150}><StateMachine /></Series.Sequence>
    <Series.Sequence name="Terminal" durationInFrames={210}><Terminal /></Series.Sequence>
    <Series.Sequence name="Projects" durationInFrames={120}><Projects /></Series.Sequence>
    <Series.Sequence name="Outro" durationInFrames={90}><Outro /></Series.Sequence>
  </Series>
);
