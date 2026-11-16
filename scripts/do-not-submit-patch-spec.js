#!/usr/bin/env node
// DO-NOT-SUBMIT: local stand-in for the L1 update.
//
// @aws-cdk/aws-service-spec 0.1.231 does not have AWS::ECS::TaskDefinition.TrustedExecutionConfiguration.
// It was added to the CloudFormation schema in cdklabs/awscdk-service-spec#3036 (2026-11-16) and is not
// in a published spec yet. This adds that property to the installed spec database, with the shapes
// from sources/CloudFormationSchema/us-east-1/aws-ecs-taskdefinition.json at awscdk-service-spec 07321fc1f,
// so the L1 can be generated. Run after `yarn install`. Drop with the official L1 update.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const specDir = path.dirname(require.resolve('@aws-cdk/aws-service-spec/package.json', {
  paths: [path.join(__dirname, '..', 'tools', '@aws-cdk', 'spec2cdk')],
}));
const file = path.join(specDir, 'db.json.gz');
const db = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
const schema = db.schema;

const taskDef = schema.resource.entities.find((r) => r.cloudFormationType === 'AWS::ECS::TaskDefinition');
if (taskDef.properties.TrustedExecutionConfiguration) {
  console.log(`TrustedExecutionConfiguration already present in ${file}`);
  process.exit(0);
}

const def = {
  $id: String(++db.idCtr),
  name: 'TrustedExecutionConfiguration',
  properties: {
    IsolationMode: {
      type: { type: 'string' },
      required: true,
      documentation: 'The isolation mode for the task. SHARED uses standard shared placement. ISOLATED_SANDBOX runs the task in its own isolated sandbox on a shared instance with hypervisor-level isolation. CONFIDENTIAL_SANDBOX runs the task in an isolated sandbox and supports an attestation policy to verify the workload before it runs.',
    },
    AttestationPolicy: {
      type: { type: 'string' },
      documentation: 'A base64-encoded attestation policy that verifies the workload before the task runs. Only valid when IsolationMode is CONFIDENTIAL_SANDBOX.',
    },
  },
};
schema.typeDefinition.entities.push(def);
schema.usesType.forward[taskDef.$id].push({ $id: def.$id });

taskDef.properties.TrustedExecutionConfiguration = {
  type: { type: 'ref', reference: { $ref: def.$id } },
};

fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(db)));
console.log(`added AWS::ECS::TaskDefinition.TrustedExecutionConfiguration to ${file}`);
