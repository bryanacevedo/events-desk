/* Prints the company-tier and assessment eval reports: baseline and rules always, the model and the second look only from fresh recordings. Makes no model call.
     node scripts/eval-report.ts */
import { companyTierReport } from "../src/evals/report.ts";
import { assessmentReport } from "../src/evals/assessment.ts";
console.log(companyTierReport());
console.log(`\n${assessmentReport()}`);
