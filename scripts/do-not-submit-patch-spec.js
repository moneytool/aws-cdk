#!/usr/bin/env node
// DO-NOT-SUBMIT: local stand-in for the L1 update.
//
// @aws-cdk/aws-service-spec 0.1.224 has AWS::ECS::Gateway and AWS::ECS::GatewayClusterAssociations
// but not AWS::ECS::Service.GatewayConnectors (cdklabs/awscdk-service-spec#2977, not released yet).
// This adds that property to the installed spec database, with the shapes from the CloudFormation
// registry schema for AWS::ECS::Service, so the L1 can be generated. Drop with the official update.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const file = path.join(path.dirname(require.resolve('@aws-cdk/aws-service-spec/package.json')), 'db.json.gz');
const db = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
const schema = db.schema;

const service = schema.resource.entities.find((r) => r.cloudFormationType === 'AWS::ECS::Service');
if (service.properties.GatewayConnectors) {
  console.log('GatewayConnectors already present');
  process.exit(0);
}

const newId = () => String(++db.idCtr);
const ref = (id) => ({ type: 'ref', reference: { $ref: id } });
const types = [];
function typeDef(name, documentation, properties) {
  const def = { $id: newId(), name, documentation, properties };
  schema.typeDefinition.entities.push(def);
  types.push(def.$id);
  return def.$id;
}

const matcher = typeDef('GatewayConnectorHealthCheckMatcher', 'The codes to use when checking for a successful response from a target.', {
  GrpcCode: { type: { type: 'string' }, documentation: 'The gRPC codes to use when checking for a successful response from a target.' },
  HttpCode: { type: { type: 'string' }, documentation: 'The HTTP codes to use when checking for a successful response from a target.' },
});
const healthCheck = typeDef('GatewayConnectorHealthCheck', 'The health check settings for the gateway connector.', {
  HealthCheckIntervalSeconds: { type: { type: 'integer' }, documentation: 'The approximate amount of time, in seconds, between health checks of an individual target.' },
  HealthCheckPath: { type: { type: 'string' }, documentation: 'The destination for health checks on the targets.' },
  HealthCheckPort: { type: { type: 'integer' }, documentation: 'The port the load balancer uses when performing health checks on targets.' },
  HealthCheckProtocol: { type: { type: 'string' }, documentation: 'The protocol the load balancer uses when performing health checks on targets. Valid values: `HTTP` | `HTTPS`' },
  HealthCheckTimeoutSeconds: { type: { type: 'integer' }, documentation: 'The amount of time, in seconds, during which no response from a target means a failed health check.' },
  HealthyThresholdCount: { type: { type: 'integer' }, documentation: 'The number of consecutive health check successes required before considering a target healthy.' },
  Matcher: { type: ref(matcher), documentation: 'The codes to use when checking for a successful response from a target.' },
  UnhealthyThresholdCount: { type: { type: 'integer' }, documentation: 'The number of consecutive health check failures required before considering a target unhealthy.' },
});
const filters = typeDef('GatewayConnectorFilters', 'The filters for the gateway connector.', {
  AccessTypes: { type: { type: 'array', element: { type: 'string' } }, documentation: 'The access types of the gateways the service is reachable through. Valid values: `PUBLIC` | `PRIVATE`' },
});
const connector = typeDef('GatewayConnector', 'The gateway connector configuration for the service.', {
  Filters: { type: ref(filters), documentation: 'The filters for the gateway connector.' },
  HealthCheck: { type: ref(healthCheck), documentation: 'The health check settings for the gateway connector.' },
  PortName: { type: { type: 'string' }, required: true, documentation: 'The name of the port mapping in the task definition that the gateway sends traffic to.' },
});

service.properties.GatewayConnectors = {
  type: { type: 'array', element: ref(connector) },
  documentation: 'The gateway connectors for the service. A service can have at most one gateway connector.',
};
const uses = schema.usesType.forward[service.$id];
for (const id of types) uses.push({ $id: id });

fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(db)));
console.log(`added AWS::ECS::Service.GatewayConnectors (${types.length} types) to ${file}`);
