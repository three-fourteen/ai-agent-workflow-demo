Status: pending

Goal: mock API

Context:
Create a standalone mock API/service module that returns analytics data as promises. It has no UI dependency, so it is built in parallel with T-002 (layout).

Dependencies: T-001

Subtasks:

1. Create a service file that returns mock data promises.
2. Define the data shape the charts will consume.
3. Add artificial latency to simulate a network request.

Done Criteria:
A mock data service module exists and returns sample analytics data.

Verification:
Import the service in a scratch test and confirm it resolves sample data.

Verify: npm run build

Next Step:
Runs in parallel with T-002. T-003 (charts) joins both once they are complete.

Blockers:
None
