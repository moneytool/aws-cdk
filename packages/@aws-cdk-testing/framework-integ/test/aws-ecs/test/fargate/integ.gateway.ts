import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as integ from '@aws-cdk/integ-tests-alpha';

const app = new cdk.App();
const stack = new cdk.Stack(app, 'aws-ecs-gateway');

const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2, natGateways: 1, restrictDefaultSecurityGroup: false });
const cluster = new ecs.Cluster(stack, 'Cluster', { vpc });

const gateway = new ecs.Gateway(stack, 'Gateway', {
  vpc,
  scheme: ecs.GatewayScheme.INTERNET_FACING,
  deletionProtection: false,
});
cluster.associateGateway(gateway);

const taskDefinition = new ecs.FargateTaskDefinition(stack, 'TaskDef');
taskDefinition.addContainer('web', {
  image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx:latest'),
  portMappings: [{ containerPort: 80, name: 'web' }],
});

new ecs.FargateService(stack, 'Service', {
  cluster,
  taskDefinition,
  minHealthyPercent: 100,
  gatewayConnector: {
    portName: 'web',
    accessTypes: [ecs.GatewayAccessType.PUBLIC],
    healthCheck: { path: '/' },
  },
});

new integ.IntegTest(app, 'GatewayTest', {
  testCases: [stack],
});

