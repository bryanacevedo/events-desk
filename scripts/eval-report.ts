/* Prints the company-tier, assessment and directory read eval reports: baseline and rules always, the model and the second look only from fresh recordings. Makes no model call.
     node scripts/eval-report.ts */
import { companyTierReport } from "../src/evals/report.ts";
import { assessmentReport } from "../src/evals/assessment.ts";
import { directoryReport } from "../src/evals/directory.ts";
console.log(companyTierReport());
console.log(`\n${assessmentReport()}`);
console.log(`\n${directoryReport()}`);
