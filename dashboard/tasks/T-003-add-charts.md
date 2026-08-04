Status: pending

Goal: add charts

Context:
Integrate a charting library and render charts inside the layout, fed by the mock API service. This is the join point: it needs both the layout (T-002) and the data service (T-004).

Dependencies: T-002, T-004

Subtasks:

1. Install a charting library (e.g., Chart.js or Recharts).
2. Render a line chart and a bar chart in the main content area.
3. Wire the charts to the mock API service with loading states.

Done Criteria:
Charts render in the layout using data fetched from the mock API service.

Verification:
Verify charts display in the browser and show a loading state before data arrives.

Verify: npm run build

Next Step:
None.

Blockers:
None
