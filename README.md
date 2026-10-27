\# SaleSphere — Self-Healing CRM



SaleSphere is a self-healing Customer Relationship Management (CRM) application designed to demonstrate how software can detect failures, diagnose problems, and recover automatically with minimal manual intervention.



\##  Key Features



\- Lead management and customer tracking

\- Sales dashboard and pipeline

\- Follow-up management

\- System health monitoring

\- Version management and automatic rollback demonstration

\- Incident tracking and recovery status

\- PatchPilot recovery component

\- Controlled chaos testing to demonstrate resilience



\##  Technology Stack



\- \*\*Frontend:\*\* React, Vite, CSS

\- \*\*Backend:\*\* Node.js, Express.js

\- \*\*Database:\*\* MongoDB, Mongoose

\- \*\*Recovery Component:\*\* PatchPilot



\##  Self-Healing Workflow



1\. \*\*Detect:\*\* Monitor the application and identify a failure.

2\. \*\*Diagnose:\*\* Record the incident and determine the recovery action.

3\. \*\*Recover:\*\* Execute the configured recovery mechanism.

4\. \*\*Verify:\*\* Check the application's health after recovery.

5\. \*\*Record:\*\* Store the incident and recovery status for review.



\## Project Documentation



\- \[AI Usage Declaration Report](./AI%20Usage%20Report.pdf)

\- \[Resilience Report](./RESILIENCE%20REPORT.pdf)

\- \[Chaos Engineering Script](./SaleSphere%20-%20chaos%20script.pdf)







\##  Failure Scenarios \& Self-Healing Mechanisms



SaleSphere is designed to demonstrate how a CRM system can detect failures, execute configured recovery actions, and verify whether normal operation has been restored. PatchPilot acts as the recovery component for supported failure scenarios.



\### 1. Bad Software Release



\*\*Failure:\*\* A newly deployed software version contains a bug and causes the application to become unhealthy.



\*\*Detection:\*\* The version health-check mechanism detects that the new release is failing.



\*\*Recovery:\*\* PatchPilot initiates the configured rollback to the last stable version.



\*\*Verification:\*\* The application health is checked again, and the incident status records whether recovery succeeded.



\### 2. MongoDB Database Disconnection



\*\*Failure:\*\* SaleSphere loses its connection to MongoDB, making normal database operations unavailable.



\*\*Detection:\*\* The backend detects the database connection problem.



\*\*Recovery Strategy:\*\* The application can use its configured local cache and queue pending lead operations for synchronization after the database reconnects.



\*\*Verification:\*\* Check whether queued changes synchronize correctly and whether leads persist in MongoDB without duplication. Offline writes and synchronization must be tested before claiming complete recovery.



\### 3. Email Delivery Failure



\*\*Failure:\*\* An email notification cannot be delivered because of a temporary service or connection problem.



\*\*Detection:\*\* The email operation reports a delivery error.



\*\*Recovery Strategy:\*\* The configured retry mechanism can attempt delivery again when the service becomes available.



\*\*Verification:\*\* Check delivery confirmation and incident logs. A retry attempt alone does not prove that the email was delivered successfully.



\### 4. API Failure



\*\*Failure:\*\* An API endpoint returns an error or becomes unavailable, interrupting a frontend operation.



\*\*Detection:\*\* The frontend or backend identifies the failed request through its error-handling and monitoring mechanisms.



\*\*Recovery Strategy:\*\* PatchPilot can perform only the recovery actions configured for that failure. Automatic process restart requires a configured process supervisor or equivalent recovery mechanism.



\*\*Verification:\*\* Repeat the affected request, check the response, and inspect the incident record to confirm whether the service recovered.



\##  Self-Healing Lifecycle



1\. \*\*Monitor:\*\* Check application health and relevant operations.

2\. \*\*Detect:\*\* Identify a failure condition.

3\. \*\*Diagnose:\*\* Record the failure type and affected component.

4\. \*\*Recover:\*\* Run the configured rollback, retry, cache, or other recovery action.

5\. \*\*Verify:\*\* Check whether the affected functionality works again.

6\. \*\*Record:\*\* Store the incident status and available timing information.



\##  Chaos Engineering \& Testing



Controlled failure scenarios are used to evaluate SaleSphere's resilience. Each test should be performed in a development environment with test data and a recovery plan.



| Test Scenario | Expected Behavior |

|---|---|

| Bad software release | Detect unhealthy release and attempt rollback |

| MongoDB disconnection | Detect disconnection and test cache/queue synchronization |

| Email delivery failure | Report failure and retry if configured |

| API failure | Detect request failure and execute configured recovery, if available |



\*\*Success Criteria:\*\* A test passes only when the failure is detected, the intended recovery action runs, and the relevant functionality is verified afterward. Record detection and recovery times from actual test results rather than estimated values.



\##  Resilience Limitations



Self-healing behavior depends on the implementation of each recovery mechanism. Detection, incident logging, retries, and automatic recovery are different capabilities. Database synchronization, email delivery, and API process recovery should be described as successful only after their respective tests pass.

\## Testing



The project includes controlled failure scenarios for demonstrating version rollback, database disconnection handling, email failure handling, and API failures. Actual recovery depends on the configured mechanism and should be verified during testing.



\##  Limitations



Recovery behavior depends on the failure scenario and its implementation. Detection alone does not guarantee automatic recovery. Tests should be performed in a controlled development environment.





\##  Project Information



\*\*Project:\*\* SaleSphere — Self-Healing CRM  

\*\*Recovery Component:\*\* PatchPilot

