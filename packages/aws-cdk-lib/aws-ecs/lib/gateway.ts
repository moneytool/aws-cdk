import type { Construct } from 'constructs';
import type { IGatewayRef, GatewayReference } from './ecs.generated';
import { CfnGateway } from './ecs.generated';
import * as ec2 from '../../aws-ec2';
import type * as elbv2 from '../../aws-elasticloadbalancingv2';
import * as iam from '../../aws-iam';
import type { Duration, IResource } from '../../core';
import { Annotations, Arn, ArnFormat, Fn, Names, Resource, Token, ValidationError } from '../../core';
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
 * access type; without a limit, gateways of both access types are eligible.
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
 *
 * Changing the health check of a service that is already connected replaces its target group,
 * which fails for services with the `ROLLING` deployment strategy. Set the health check when the
 * service is first connected, or use the `BLUE_GREEN` or `CANARY` deployment strategy.
 */
export interface GatewayConnectorHealthCheck {
  /**
   * The path the gateway sends health check requests to. Must start with `/`.
   *
   * @default '/'
   */
  readonly path?: string;

  /**
   * The port the gateway sends health check requests to.
   *
   * @default - the port of the connector's named port mapping
   */
  readonly port?: number;

  /**
   * The protocol of the health check requests.
   *
   * @default GatewayHealthCheckProtocol.HTTP
   */
  readonly protocol?: GatewayHealthCheckProtocol;

  /**
   * The time between health checks of a task. Between 5 and 300 seconds.
   *
   * @default Duration.seconds(30)
   */
  readonly interval?: Duration;

  /**
   * The time after which a health check without a response fails. Between 2 and 120 seconds,
   * and less than `interval`.
   *
   * @default Duration.seconds(5)
   */
  readonly timeout?: Duration;

  /**
   * The number of consecutive successful health checks before a task is considered healthy.
   * Between 2 and 10.
   *
   * @default - the Amazon ECS default
   */
  readonly healthyThresholdCount?: number;

  /**
   * The number of consecutive failed health checks before a task is considered unhealthy.
   * Between 2 and 10.
   *
   * @default - the Amazon ECS default
   */
  readonly unhealthyThresholdCount?: number;

  /**
   * The HTTP codes of a successful health check, for example `200` or `200-299`.
   *
   * Can't be combined with `healthyGrpcCodes`.
   *
   * @default '200'
   */
  readonly healthyHttpCodes?: string;

  /**
   * The gRPC codes of a successful health check, for example `0` or `0-99`.
   *
   * Can't be combined with `healthyHttpCodes`.
   *
   * @default - HTTP codes are used
   */
  readonly healthyGrpcCodes?: string;
}

/**
 * How a service receives traffic through the gateways associated with its cluster.
 *
 * The task definition must use the `awsvpc` network mode, and a service can have one gateway
 * connector.
 */
export interface GatewayConnectorOptions {
  /**
   * The name of the port mapping in the task definition that the gateway sends traffic to.
   */
  readonly portName: string;

  /**
   * The access types of the gateways the service receives traffic from.
   *
   * Without this, the service is also reachable through internet-facing (`PUBLIC`) gateways
   * associated with the cluster. Use `[GatewayAccessType.PRIVATE]` for a service that must not
   * be reachable from the internet.
   *
   * @default - gateways of both access types
   */
  readonly accessTypes?: GatewayAccessType[];

  /**
   * The health check the gateway runs against the service's tasks.
   *
   * Changing the health check of a connected service fails for services with the `ROLLING`
   * deployment strategy; see `GatewayConnectorHealthCheck`.
   *
   * @default - HTTP on path `/` of the named port, every 30 seconds with a 5 second timeout,
   * healthy on HTTP code 200
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

  /**
   * The name of the gateway.
   *
   * @attribute
   */
  readonly gatewayName: string;
}

/**
 * Properties for an Amazon ECS gateway.
 */
export interface GatewayProps {
  /**
   * The VPC to place the gateway's load balancer in. Services that use the gateway must run in
   * the same VPC.
   *
   * [disable-awslint:prefer-ref-interface] the subnets are selected from the VPC
   */
  readonly vpc: ec2.IVpc;

  /**
   * The subnets to place the gateway's load balancer in.
   *
   * At least two subnets in different Availability Zones are required, and the gateway must
   * cover every Availability Zone the services that use it run in. Changing the subnets replaces
   * the gateway.
   *
   * @default - the VPC's public subnets for an internet-facing gateway, and its private subnets
   * for an internal gateway
   */
  readonly vpcSubnets?: ec2.SubnetSelection;

  /**
   * Whether the gateway's load balancer is reachable from the internet.
   *
   * Changing the scheme replaces the gateway.
   *
   * @default GatewayScheme.INTERNAL
   */
  readonly scheme?: GatewayScheme;

  /**
   * The IP address type of the gateway's load balancer.
   *
   * Changing the IP address type replaces the gateway.
   *
   * @default - IPv4 (the Amazon ECS default)
   */
  readonly ipAddressType?: elbv2.IpAddressType;

  /**
   * The name of the gateway. Unique in the account and Region.
   *
   * Up to 255 letters, numbers and hyphens. Changing the name replaces the gateway.
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
  readonly infrastructureRole?: iam.IRoleRef;

  /**
   * Whether the gateway is protected from deletion.
   *
   * While deletion protection is on, deleting or replacing the gateway, including through a stack
   * delete or a change to a property that replaces the gateway, fails.
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
   *
   * The ARN has the form `arn:<partition>:ecs:<region>:<account>:gateway/<name>/<id>`.
   */
  public static fromGatewayArn(scope: Construct, id: string, gatewayArn: string): IGateway {
    const arn = Arn.split(gatewayArn, ArnFormat.SLASH_RESOURCE_NAME);
    let gatewayName: string;
    if (Token.isUnresolved(gatewayArn)) {
      gatewayName = Fn.select(0, Fn.split('/', arn.resourceName!));
    } else {
      if (arn.service !== 'ecs' || arn.resource !== 'gateway' || !arn.resourceName) {
        throw new ValidationError(lit`InvalidGatewayArn`, `gatewayArn must be an ARN of the form arn:<partition>:ecs:<region>:<account>:gateway/<name>/<id>, got ${JSON.stringify(gatewayArn)}`, scope);
      }
      gatewayName = arn.resourceName.split('/')[0];
    }

    class Import extends Resource implements IGateway {
      public readonly gatewayArn = gatewayArn;
      public readonly gatewayName = gatewayName;

      public get gatewayRef(): GatewayReference {
        return { gatewayArn: this.gatewayArn };
      }
    }
    return new Import(scope, id, { environmentFromArn: gatewayArn });
  }

  /**
   * The ARN of the gateway.
   *
   * @attribute
   */
  public readonly gatewayArn: string;

  /**
   * The name of the gateway.
   *
   * @attribute
   */
  public readonly gatewayName: string;

  /**
   * The IAM role that Amazon ECS uses to manage the gateway's infrastructure.
   */
  public readonly infrastructureRole: iam.IRoleRef;

  /**
   * Whether the gateway's load balancer is reachable from the internet.
   */
  public readonly scheme: GatewayScheme;

  constructor(scope: Construct, id: string, props: GatewayProps) {
    super(scope, id, { physicalName: props.gatewayName });
    // Enhanced CDK Analytics Telemetry
    addConstructMetadata(this, props);

    if (props.gatewayName !== undefined && !Token.isUnresolved(props.gatewayName)
      && !/^[a-zA-Z0-9-]{1,255}$/.test(props.gatewayName)) {
      throw new ValidationError(lit`InvalidGatewayName`, `gatewayName must be 1 to 255 letters, numbers and hyphens, got ${JSON.stringify(props.gatewayName)}`, this);
    }
    this.gatewayName = props.gatewayName ?? Names.uniqueResourceName(this, { maxLength: 255, separator: '-' });

    this.scheme = props.scheme ?? GatewayScheme.INTERNAL;
    if (this.scheme === GatewayScheme.INTERNET_FACING) {
      Annotations.of(this).addWarningV2('@aws-cdk/aws-ecs:gatewayInternetFacing',
        'This gateway is internet-facing: services in its clusters with a gateway connector that does not limit accessTypes to PRIVATE can be reached from the internet.');
    }

    const subnets = props.vpc.selectSubnets(props.vpcSubnets ?? {
      subnetType: this.scheme === GatewayScheme.INTERNET_FACING ? ec2.SubnetType.PUBLIC : ec2.SubnetType.PRIVATE_WITH_EGRESS,
    });
    if (!Token.isUnresolved(subnets.subnetIds) && subnets.subnetIds.length < 2) {
      throw new ValidationError(lit`GatewayNeedsTwoSubnets`, `a gateway needs at least 2 subnets in different Availability Zones, got ${subnets.subnetIds.length} subnet(s)`, this);
    }
    const azs = subnets.availabilityZones;
    if (azs.length === subnets.subnetIds.length && azs.every(az => az && !Token.isUnresolved(az)) && new Set(azs).size < 2) {
      throw new ValidationError(lit`GatewayNeedsTwoAzs`, `a gateway needs subnets in at least 2 different Availability Zones, got ${JSON.stringify([...new Set(azs)])}`, this);
    }

    this.infrastructureRole = props.infrastructureRole ?? new iam.Role(this, 'InfrastructureRole', {
      assumedBy: new iam.ServicePrincipal('ecs.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonECSInfrastructureRoleForGatewayHostSharedALB'),
      ],
    });

    const resource = new CfnGateway(this, 'Resource', {
      gatewayName: this.gatewayName,
      infrastructureRoleArn: this.infrastructureRole.roleRef.roleArn,
      deletionProtection: props.deletionProtection,
      configuration: {
        hostSharedAlb: {
          scheme: this.scheme,
          networkConfiguration: {
            subnets: subnets.subnetIds,
            ipAddressType: props.ipAddressType,
          },
        },
      },
    });

    this.gatewayArn = resource.attrArn;
  }

  public get gatewayRef(): GatewayReference {
    return { gatewayArn: this.gatewayArn };
  }
}
