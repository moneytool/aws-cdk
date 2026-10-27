import type { Construct } from 'constructs';
import type { IGatewayRef, GatewayReference } from './ecs.generated';
import { CfnGateway } from './ecs.generated';
import * as ec2 from '../../aws-ec2';
import * as iam from '../../aws-iam';
import type { Duration, IResource } from '../../core';
import { Annotations, Names, Resource, Stack, Token, ValidationError } from '../../core';
import { memoizedGetter } from '../../core/lib/helpers-internal';
import { addConstructMetadata } from '../../core/lib/metadata-resource';
import { lit } from '../../core/lib/private/literal-string';
import { propertyInjectable } from '../../core/lib/prop-injectable';

/**
 * Whether the load balancer of an Amazon ECS gateway is reachable from the internet.
 */
export enum GatewayScheme {
  /**
   * The load balancer has public IP addresses and routes requests from the internet.
   */
  INTERNET_FACING = 'internet-facing',

  /**
   * The load balancer has only private IP addresses and routes requests from inside the VPC.
   */
  INTERNAL = 'internal',
}

/**
 * The access type of an Amazon ECS gateway.
 *
 * A gateway with an internet-facing scheme has the `PUBLIC` access type, and an internal one has
 * the `PRIVATE` access type. A service's gateway connector can be limited to gateways of an
 * access type.
 */
export enum GatewayAccessType {
  /**
   * Gateways with an internet-facing load balancer.
   */
  PUBLIC = 'PUBLIC',

  /**
   * Gateways with an internal load balancer.
   */
  PRIVATE = 'PRIVATE',
}

/**
 * The protocol a gateway uses for health checks of a service's tasks.
 */
export enum GatewayHealthCheckProtocol {
  /**
   * HTTP
   */
  HTTP = 'HTTP',

  /**
   * HTTPS
   */
  HTTPS = 'HTTPS',
}

/**
 * The health check a gateway runs against the tasks of a service.
 */
export interface GatewayConnectorHealthCheck {
  /**
   * The path the gateway sends health check requests to.
   *
   * @default - the Amazon ECS default
   */
  readonly path?: string;

  /**
   * The port the gateway sends health check requests to.
   *
   * @default - the port of the connector's port mapping
   */
  readonly port?: number;

  /**
   * The protocol of the health check requests.
   *
   * @default - the Amazon ECS default
   */
  readonly protocol?: GatewayHealthCheckProtocol;

  /**
   * The time between health checks of a task.
   *
   * @default - the Amazon ECS default
   */
  readonly interval?: Duration;

  /**
   * The time after which a health check without a response fails.
   *
   * @default - the Amazon ECS default
   */
  readonly timeout?: Duration;

  /**
   * The number of consecutive successful health checks before a task is considered healthy.
   *
   * @default - the Amazon ECS default
   */
  readonly healthyThresholdCount?: number;

  /**
   * The number of consecutive failed health checks before a task is considered unhealthy.
   *
   * @default - the Amazon ECS default
   */
  readonly unhealthyThresholdCount?: number;

  /**
   * The HTTP codes of a successful health check, for example `200` or `200-299`.
   *
   * @default - the Amazon ECS default
   */
  readonly healthyHttpCodes?: string;

  /**
   * The gRPC codes of a successful health check, for example `0` or `0-99`.
   *
   * @default - the Amazon ECS default
   */
  readonly healthyGrpcCodes?: string;
}

/**
 * How a service receives traffic through the gateways associated with its cluster.
 */
export interface GatewayConnectorOptions {
  /**
   * The name of the port mapping in the task definition that the gateway sends traffic to.
   */
  readonly portName: string;

  /**
   * The access types of the gateways the service receives traffic from.
   *
   * @default - gateways of both access types
   */
  readonly accessTypes?: GatewayAccessType[];

  /**
   * The health check the gateway runs against the service's tasks.
   *
   * @default - the Amazon ECS default health check
   */
  readonly healthCheck?: GatewayConnectorHealthCheck;
}

/**
 * An Amazon ECS gateway.
 */
export interface IGateway extends IResource, IGatewayRef {
  /**
   * The ARN of the gateway.
   *
   * @attribute
   */
  readonly gatewayArn: string;
}

/**
 * Properties for an Amazon ECS gateway.
 */
export interface GatewayProps {
  /**
   * The VPC to place the gateway's load balancer in.
   */
  readonly vpc: ec2.IVpc;

  /**
   * The subnets to place the gateway's load balancer in. At least two subnets are required.
   *
   * @default - the VPC's public subnets for an internet-facing gateway, and its private subnets
   * for an internal gateway
   */
  readonly vpcSubnets?: ec2.SubnetSelection;

  /**
   * Whether the gateway's load balancer is reachable from the internet.
   *
   * @default GatewayScheme.INTERNAL
   */
  readonly scheme?: GatewayScheme;

  /**
   * The name of the gateway.
   *
   * Up to 255 letters, numbers and hyphens.
   *
   * @default - a name generated from the construct path
   */
  readonly gatewayName?: string;

  /**
   * The IAM role that Amazon ECS uses to manage the load balancer and related resources of the gateway.
   *
   * @default - a role that Amazon ECS can assume, with the `AmazonECSInfrastructureRoleForGatewayHostSharedALB`
   * managed policy
   */
  readonly infrastructureRole?: iam.IRole;

  /**
   * Whether the gateway is protected from deletion.
   *
   * While deletion protection is on, deleting the gateway, including through a stack delete, fails.
   *
   * @default true
   */
  readonly deletionProtection?: boolean;
}

/**
 * An Amazon ECS gateway: an Application Load Balancer that Amazon ECS manages and shares between
 * the services of the clusters the gateway is associated with.
 *
 * Associate the gateway with a cluster with `cluster.associateGateway()`, then give a service a
 * `gatewayConnector` to route traffic to it through the gateway.
 *
 * @resource AWS::ECS::Gateway
 */
@propertyInjectable
export class Gateway extends Resource implements IGateway {
  /**
   * Uniquely identifies this class.
   */
  public static readonly PROPERTY_INJECTION_ID: string = 'aws-cdk-lib.aws-ecs.Gateway';

  /**
   * Import an existing gateway from its ARN.
   */
  public static fromGatewayArn(scope: Construct, id: string, gatewayArn: string): IGateway {
    class Import extends Resource implements IGateway {
      public readonly gatewayArn = gatewayArn;

      public get gatewayRef(): GatewayReference {
        return { gatewayArn: this.gatewayArn };
      }
    }
    return new Import(scope, id, { environmentFromArn: gatewayArn });
  }

  /**
   * The IAM role that Amazon ECS uses to manage the gateway's infrastructure.
   */
  public readonly infrastructureRole: iam.IRole;

  /**
   * Whether the gateway's load balancer is reachable from the internet.
   */
  public readonly scheme: GatewayScheme;

  private readonly resource: CfnGateway;

  constructor(scope: Construct, id: string, props: GatewayProps) {
    super(scope, id, { physicalName: props.gatewayName });
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);

    if (props.gatewayName !== undefined && !Token.isUnresolved(props.gatewayName)
      && !/^[a-zA-Z0-9-]{1,255}$/.test(props.gatewayName)) {
      throw new ValidationError(lit`InvalidGatewayName`, `gatewayName must be 1 to 255 letters, numbers and hyphens, got ${JSON.stringify(props.gatewayName)}`, this);
    }

    this.scheme = props.scheme ?? GatewayScheme.INTERNAL;
    if (this.scheme === GatewayScheme.INTERNET_FACING) {
      Annotations.of(this).addWarningV2('@aws-cdk/aws-ecs:gatewayInternetFacing',
        'This gateway is internet-facing: services with a gateway connector for PUBLIC gateways can be reached from the internet.');
    }

    const subnets = props.vpc.selectSubnets(props.vpcSubnets ?? {
      subnetType: this.scheme === GatewayScheme.INTERNET_FACING ? ec2.SubnetType.PUBLIC : ec2.SubnetType.PRIVATE_WITH_EGRESS,
    });
    if (!Token.isUnresolved(subnets.subnetIds) && subnets.subnetIds.length < 2) {
      throw new ValidationError(lit`GatewayNeedsTwoSubnets`, `a gateway needs at least 2 subnets, got ${subnets.subnetIds.length}`, this);
    }

    this.infrastructureRole = props.infrastructureRole ?? new iam.Role(this, 'InfrastructureRole', {
      assumedBy: new iam.ServicePrincipal('ecs.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': Stack.of(this).account },
        },
      }),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSInfrastructureRoleForGatewayHostSharedALB'),
      ],
    });

    const resource = this.resource = new CfnGateway(this, 'Resource', {
      gatewayName: props.gatewayName ?? Names.uniqueResourceName(this, { maxLength: 255, separator: '-' }),
      infrastructureRoleArn: this.infrastructureRole.roleArn,
      deletionProtection: props.deletionProtection,
      configuration: {
        hostSharedAlb: {
          scheme: this.scheme,
          networkConfiguration: {
            subnets: subnets.subnetIds,
          },
        },
      },
    });
    // the infrastructure role must be able to manage the load balancer before the gateway is created
    resource.node.addDependency(this.infrastructureRole);
  }

  /**
   * The ARN of the gateway.
   *
   * @attribute
   */
  @memoizedGetter
  public get gatewayArn(): string {
    return this.getResourceArnAttribute(this.resource.attrArn, {
      service: 'ecs',
      resource: 'gateway',
      resourceName: this.physicalName,
    });
  }

  public get gatewayRef(): GatewayReference {
    return { gatewayArn: this.gatewayArn };
  }
}
