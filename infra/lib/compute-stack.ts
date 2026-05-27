import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface ComputeStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  ec2Sg: ec2.SecurityGroup;
  modelBucket: s3.Bucket;
  publicSubnetId: string;
}

export class ComputeStack extends cdk.Stack {
  public readonly launchTemplateName = 'secure-llm';

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    props.modelBucket.grantReadWrite(role, 'secure-llm/*');

    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:eu-west-2:${this.account}:parameter/secure-llm/*`],
    }));

    role.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: ['*'],
    }));

    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:TerminateInstances'],
      resources: ['*'],
      conditions: { StringEquals: { 'ec2:ResourceTag/Name': 'secure-llm' } },
    }));

    // DLAMI: NVIDIA driver, Docker, nvidia-container-toolkit pre-installed
    // GPU path: use DLAMI + Docker with --gpus all
    // CPU path (t3.large smoke test): standard AL2023 + Ollama binary (no Docker needed)
    const ami = ec2.MachineImage.latestAmazonLinux2023();

    const script = `#!/bin/bash
set -euo pipefail
MODEL_BUCKET="${props.modelBucket.bucketName}"
REGION="eu-west-2"
LOG=/var/log/secure-llm.log
exec >> $LOG 2>&1

echo "=== Boot $(date) ==="
export HOME=/root

# Install Ollama binary (CPU mode — no Docker/GPU needed)
curl -fsSL https://ollama.com/install.sh | sh

# Pull model cache from S3 (no-op on first run, fast on subsequent)
mkdir -p /root/.ollama/models
aws s3 sync "s3://$MODEL_BUCKET/secure-llm/ollama/" /root/.ollama/models/ --region $REGION --quiet || true

# Start Ollama
OLLAMA_HOST=0.0.0.0:11434 nohup ollama serve >> $LOG 2>&1 &
until curl -sf http://localhost:11434/api/tags > /dev/null; do sleep 3; done
echo "Ollama ready"

# llama3.2:1b for CPU demo (fits API GW 29s timeout). Switch to llama3:8b on GPU.
if ! ollama list | grep -q "llama3.2:1b"; then
  ollama pull llama3.2:1b
fi

# Warm S3 cache for next boot
aws s3 sync /root/.ollama/models/ "s3://$MODEL_BUCKET/secure-llm/ollama/" --region $REGION --quiet || true

# Install FastAPI gateway
dnf install -y python3-pip
pip3 install fastapi uvicorn httpx

mkdir -p /opt/secure-llm
aws s3 cp "s3://$MODEL_BUCKET/secure-llm/deploy/main.py" /opt/secure-llm/main.py --region $REGION

API_KEY=$(aws ssm get-parameter --name /secure-llm/api-key --with-decryption --query Parameter.Value --output text --region $REGION 2>/dev/null || echo "")
echo "API_KEY=$API_KEY" > /etc/secure-llm.env
chmod 600 /etc/secure-llm.env

printf '[Unit]\\nDescription=Secure LLM FastAPI\\nAfter=network.target\\n\\n[Service]\\nWorkingDirectory=/opt/secure-llm\\nEnvironmentFile=/etc/secure-llm.env\\nExecStart=/usr/bin/python3 -m uvicorn main:app --host 0.0.0.0 --port 8000\\nRestart=always\\nRestartSec=3\\n\\n[Install]\\nWantedBy=multi-user.target\\n' > /etc/systemd/system/fastapi.service

systemctl daemon-reload
systemctl enable --now fastapi
echo "=== Gateway ready ==="
`;

    const userData = ec2.UserData.forLinux();
    userData.addCommands(script);

    // No securityGroup here — it goes in NetworkInterfaces so subnet + SG are co-located
    const lt = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      launchTemplateName: this.launchTemplateName,
      // TODO: switch back to G4DN.XLARGE once GPU quota L-DB2E81BA approved
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.LARGE),
      machineImage: ami,
      role,
      userData,
    });

    const cfnLt = lt.node.defaultChild as ec2.CfnLaunchTemplate;

    // 20GB root volume — default 8GB is too small for Ollama binary + llama3:8b (4.7GB)
    cfnLt.addPropertyOverride('LaunchTemplateData.BlockDeviceMappings', [{
      DeviceName: '/dev/xvda',
      Ebs: { VolumeSize: 20, VolumeType: 'gp3', DeleteOnTermination: true },
    }]);

    // Terminate (not stop) on shutdown so idle watchdog fully cleans up the instance
    cfnLt.addPropertyOverride('LaunchTemplateData.InstanceInitiatedShutdownBehavior', 'terminate');

    // Tag instances so ec2:TerminateInstances IAM condition matches
    cfnLt.addPropertyOverride('LaunchTemplateData.TagSpecifications', [{
      ResourceType: 'instance',
      Tags: [{ Key: 'Name', Value: 'secure-llm' }],
    }]);

    // Bake subnet + SG into the template so RunInstances needs no network params
    cfnLt.addPropertyOverride('LaunchTemplateData.NetworkInterfaces', [{
      DeviceIndex: 0,
      SubnetId: props.publicSubnetId,
      Groups: [props.ec2Sg.securityGroupId],
      AssociatePublicIpAddress: true,
    }]);

    // TODO: switch back to Spot once quota L-3819A6DF is approved (currently 0 vCPUs)
    // cfnLt.addPropertyOverride('LaunchTemplateData.InstanceMarketOptions', {
    //   MarketType: 'spot',
    //   SpotOptions: { SpotInstanceType: 'one-time', InstanceInterruptionBehavior: 'terminate' },
    // });

    new cdk.CfnOutput(this, 'LaunchTemplateName', { value: this.launchTemplateName });
  }
}
