import { Annotations, Match, Template } from '../../assertions';
import * as ec2 from '../../aws-ec2';
import * as iam from '../../aws-iam';
import * as cdk from '../../core';
import * as ecs from '../lib';
import { acknowledgeTestValidationRules } from './util';

describe('gateway', () => {
  let stack: cdk.Stack;
  let vpc: ec2.Vpc;

  beforeEach(() => {
    stack = new cdk.Stack();
    acknowledgeTestValidationRules(stack);
    vpc = new ec2.Vpc(stack, 'Vpc');
  });

  test('defaults to an internal gateway in the private subnets with a new infrastructure role', () => {
    new ecs.Gateway(stack, 'Gateway', { vpc });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ECS::Gateway', {
      GatewayName: Match.stringLikeRegexp('^[A-Za-z0-9-]*Gateway[A-Za-z0-9-]*$'),
      InfrastructureRoleArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^GatewayInfrastructureRole'), 'Arn'] },
      DeletionProtection: Match.absent(),
      Configuration: {
        HostSharedAlb: {
          Scheme: 'internal',
          NetworkConfiguration: {
            Subnets: [
              { Ref: 'VpcPrivateSubnet1Subnet536B997A' },
              { Ref: 'VpcPrivateSubnet2Subnet3788AAA1' },
            ],
          },
        },
      },
    });
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [{
          Action: 'sts:AssumeRole',
          Effect: 'Allow',
          Principal: { Service: 'ecs.amazonaws.com' },
          Condition: { StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } } },
        }],
      },
      ManagedPolicyArns: [{
        'Fn::Join': ['', [
          'arn:',
          { Ref: 'AWS::Partition' },
          ':iam::aws:policy/service-role/AmazonECSInfrastructureRoleForGatewayHostSharedALB',
        ]],
      }],
    });
    template.hasResource('AWS::ECS::Gateway', {
      DependsOn: Match.arrayWith([Match.stringLikeRegexp('^GatewayInfrastructureRole')]),
    });
  });

  test('internet-facing gateway uses the public subnets and warns', () => {
    const gateway = new ecs.Gateway(stack, 'Gateway', {
      vpc,
      scheme: ecs.GatewayScheme.INTERNET_FACING,
    });

    expect(gateway.scheme).toEqual(ecs.GatewayScheme.INTERNET_FACING);
    Template.fromStack(stack).hasResourceProperties('AWS::ECS::Gateway', {
      Configuration: {
        HostSharedAlb: {
          Scheme: 'internet-facing',
          NetworkConfiguration: {
            Subnets: [
              { Ref: 'VpcPublicSubnet1Subnet5C2D37C4' },
              { Ref: 'VpcPublicSubnet2Subnet691E08A3' },
            ],
          },
        },
      },
    });
    Annotations.fromStack(stack).hasWarning('/Default/Gateway', Match.stringLikeRegexp('internet-facing'));
  });

  test('uses the given name, role, subnets and deletion protection', () => {
    const role = iam.Role.fromRoleArn(stack, 'Role', 'arn:aws:iam::123456789012:role/gateway');

    new ecs.Gateway(stack, 'Gateway', {
      vpc,
      gatewayName: 'my-gateway',
      infrastructureRole: role,
      deletionProtection: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ECS::Gateway', {
      GatewayName: 'my-gateway',
      InfrastructureRoleArn: 'arn:aws:iam::123456789012:role/gateway',
      DeletionProtection: false,
      Configuration: {
        HostSharedAlb: {
          Scheme: 'internal',
          NetworkConfiguration: {
            Subnets: [
              { Ref: 'VpcPublicSubnet1Subnet5C2D37C4' },
              { Ref: 'VpcPublicSubnet2Subnet691E08A3' },
            ],
          },
        },
      },
    });
    template.resourceCountIs('AWS::IAM::Role', 0);
  });

  test.each(['', 'has_underscore', 'a'.repeat(256)])('fails for gateway name %j', (gatewayName) => {
    expect(() => new ecs.Gateway(stack, 'Gateway', { vpc, gatewayName }))
      .toThrow(/gatewayName must be 1 to 255 letters, numbers and hyphens/);
  });

  test('fails with fewer than 2 subnets', () => {
    expect(() => new ecs.Gateway(stack, 'Gateway', {
      vpc,
      vpcSubnets: { subnets: [vpc.privateSubnets[0]] },
    })).toThrow(/a gateway needs at least 2 subnets, got 1/);
  });

  test('imports a gateway from its ARN', () => {
    const arn = 'arn:aws:ecs:us-west-2:123456789012:gateway/imported';
    const gateway = ecs.Gateway.fromGatewayArn(stack, 'Imported', arn);

    expect(gateway.gatewayArn).toEqual(arn);
    expect(gateway.gatewayRef.gatewayArn).toEqual(arn);
    expect(gateway.env.region).toEqual('us-west-2');
    expect(gateway.env.account).toEqual('123456789012');
  });
});

describe('gateway connector', () => {
  let stack: cdk.Stack;
  let cluster: ecs.Cluster;
  let taskDefinition: ecs.FargateTaskDefinition;

  beforeEach(() => {
    stack = new cdk.Stack();
    acknowledgeTestValidationRules(stack);
    const vpc = new ec2.Vpc(stack, 'Vpc');
    cluster = new ecs.Cluster(stack, 'Cluster', { vpc });
    taskDefinition = new ecs.FargateTaskDefinition(stack, 'TaskDef');
    taskDefinition.addContainer('web', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx:latest'),
      portMappings: [{ containerPort: 80, name: 'web' }],
    });
  });

  test('cluster associates a gateway', () => {
    const gateway = ecs.Gateway.fromGatewayArn(stack, 'Gateway', 'arn:aws:ecs:us-east-1:123456789012:gateway/gw');

    cluster.associateGateway(gateway);

    Template.fromStack(stack).hasResourceProperties('AWS::ECS::GatewayClusterAssociations', {
      Cluster: { Ref: 'ClusterEB0386A7' },
      Gateway: 'arn:aws:ecs:us-east-1:123456789012:gateway/gw',
    });
  });

  test('renders the gateway connector and depends on the cluster gateway associations', () => {
    const gateway = new ecs.Gateway(stack, 'Gateway', { vpc: cluster.vpc });
    new ecs.FargateService(stack, 'Service', {
      cluster,
      taskDefinition,
      gatewayConnector: {
        portName: 'web',
        accessTypes: [ecs.GatewayAccessType.PRIVATE],
        healthCheck: {
          path: '/health',
          port: 8080,
          protocol: ecs.GatewayHealthCheckProtocol.HTTP,
          interval: cdk.Duration.seconds(15),
          timeout: cdk.Duration.seconds(5),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
          healthyHttpCodes: '200-299',
        },
      },
    });
    // associated after the service is created: the dependency is still added
    cluster.associateGateway(gateway);

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ECS::Service', {
      GatewayConnectors: [{
        PortName: 'web',
        Filters: { AccessTypes: ['PRIVATE'] },
        HealthCheck: {
          HealthCheckPath: '/health',
          HealthCheckPort: 8080,
          HealthCheckProtocol: 'HTTP',
          HealthCheckIntervalSeconds: 15,
          HealthCheckTimeoutSeconds: 5,
          HealthyThresholdCount: 2,
          UnhealthyThresholdCount: 3,
          Matcher: { HttpCode: '200-299' },
        },
      }],
    });
    const associations = template.findResources('AWS::ECS::GatewayClusterAssociations');
    expect(Object.keys(associations)).toHaveLength(1);
    template.hasResource('AWS::ECS::Service', {
      DependsOn: Match.arrayWith([Object.keys(associations)[0]]),
    });
  });

  test('renders only the port name by default', () => {
    new ecs.FargateService(stack, 'Service', {
      cluster,
      taskDefinition,
      gatewayConnector: { portName: 'web' },
    });

    Template.fromStack(stack).hasResourceProperties('AWS::ECS::Service', {
      GatewayConnectors: [{
        PortName: 'web',
        Filters: Match.absent(),
        HealthCheck: Match.absent(),
      }],
    });
  });

  test('without a gateway connector the service has no GatewayConnectors', () => {
    new ecs.FargateService(stack, 'Service', { cluster, taskDefinition });

    Template.fromStack(stack).hasResourceProperties('AWS::ECS::Service', {
      GatewayConnectors: Match.absent(),
    });
  });

  test('fails when the port name does not match a port mapping', () => {
    new ecs.FargateService(stack, 'Service', {
      cluster,
      taskDefinition,
      gatewayConnector: { portName: 'api' },
    });

    expect(() => Template.fromStack(stack))
      .toThrow(/gatewayConnector portName "api" does not match the name of a port mapping in the task definition/);
  });

  test('accepts a port mapping added after the service', () => {
    new ecs.FargateService(stack, 'Service', {
      cluster,
      taskDefinition,
      gatewayConnector: { portName: 'api' },
    });
    taskDefinition.addContainer('api', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx:latest'),
      portMappings: [{ containerPort: 8080, name: 'api' }],
    });

    expect(() => Template.fromStack(stack)).not.toThrow();
  });

  test.each([0, 65536])('fails for health check port %d', (port) => {
    expect(() => new ecs.FargateService(stack, 'Service', {
      cluster,
      taskDefinition,
      gatewayConnector: { portName: 'web', healthCheck: { port } },
    })).toThrow(/gatewayConnector health check port must be between 1 and 65535/);
  });

  test.each([
    [[]],
    [[ecs.GatewayAccessType.PUBLIC, ecs.GatewayAccessType.PUBLIC]],
  ])('fails for access types %j', (accessTypes) => {
    expect(() => new ecs.FargateService(stack, 'Service', {
      cluster,
      taskDefinition,
      gatewayConnector: { portName: 'web', accessTypes },
    })).toThrow(/gatewayConnector accessTypes must be a non-empty list without duplicates/);
  });
});
