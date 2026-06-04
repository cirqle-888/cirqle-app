#!/bin/bash
sed -i '' -e 's/let employeeTaskIds: string\[\] | null = null/let employeeTaskIds: string\[\] | null = null/' src/app/\(dashboard\)/dashboard/tasks/page.tsx
