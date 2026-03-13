Status: pending

Goal: fake auth

Context:
Implement generic basic stateful mock authentication that routes the user appropriately upon signup login to simulate the authentication flow.

Dependencies:
T-002-signup-ui

Subtasks:

1. Implement dummy state management to store "logged_in" status.
2. Form submission updates state instead of executing an API post.
3. Redirect user upon a successful synthetic login.

Done Criteria:
Sumbitting the signup UI redirects to a logged-in empty dashboard view.

Verification:
Verify completion of signup flow moves user to dashboard.

Next Step:
Proceed to T-004.

Blockers:
None
