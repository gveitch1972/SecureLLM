import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface ComputeStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  ec2Sg: ec2.SecurityGroup;
  modelBucket: s3.Bucket;
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
    const ami = ec2.MachineImage.lookup({
      name: 'Deep Learning OSS Nvidia Driver AMI GPU PyTorch 2.5 (Amazon Linux 2023)*',
      owners: ['amazon'],
    });

    const script = `#!/bin/bash
set -euo pipefail
MODEL_BUCKET="${props.modelBucket.bucketName}"
REGION="eu-west-2"
LOG=/var/log/secure-llm.log
exec >> $LOG 2>&1

echo "=== Boot $(date) ==="

# Pull Ollama model cache from S3 (no-op on first run, fast on subsequent)
mkdir -p /root/.ollama/models
aws s3 sync "s3://$MODEL_BUCKET/secure-llm/ollama/" /root/.ollama/models/ --region $REGION --quiet || true

# DLAMI has Docker + nvidia-container-toolkit pre-installed
docker run -d \\
  --gpus all \\
  --name ollama \\
  -v /root/.ollama:/root/.ollama \\
  -p 11434:11434 \\
  --restart unless-stopped \\
  ollama/ollama

until curl -sf http://localhost:11434/api/tags > /dev/null; do sleep 3; done
echo "Ollama ready"

if ! docker exec ollama ollama list | grep -q "llama3:8b"; then
  docker exec ollama ollama pull llama3:8b
fi

# Warm S3 cache for next boot
aws s3 sync /root/.ollama/models/ "s3://$MODEL_BUCKET/secure-llm/ollama/" --region $REGION --quiet || true

# Install FastAPI gateway
pip3 install fastapi uvicorn httpx

mkdir -p /opt/secure-llm
cat > /opt/secure-llm/main.py << 'PYEOF'
import os
import httpx
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
API_KEY = os.getenv("API_KEY", "")

app = FastAPI(title="Secure LLM Gateway")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

def check_key(key: Optional[str]) -> None:
    if API_KEY and key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")

class Message(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    model: str = "llama3:8b"
    messages: List[Message]

@app.get("/health")
def health():
    return {"status": "ok"}

@app.get("/models")
async def models(x_api_key: Optional[str] = Header(default=None)):
    check_key(x_api_key)
    async with httpx.AsyncClient() as c:
        r = await c.get(f"{OLLAMA_URL}/api/tags")
        return r.json()

@app.post("/chat")
async def chat(req: ChatRequest, x_api_key: Optional[str] = Header(default=None)):
    check_key(x_api_key)
    async with httpx.AsyncClient(timeout=120.0) as c:
        r = await c.post(f"{OLLAMA_URL}/api/chat", json={
            "model": req.model,
            "messages": [m.model_dump() for m in req.messages],
            "stream": False,
        })
        r.raise_for_status()
        return r.json()
PYEOF

export API_KEY=$(aws ssm get-parameter --name /secure-llm/api-key --with-decryption --query Parameter.Value --output text --region $REGION 2>/dev/null || echo "")
cd /opt/secure-llm && nohup python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 >> $LOG 2>&1 &

echo "=== Gateway ready ==="
`;

    const userData = ec2.UserData.forLinux();
    userData.addCommands(script);

    const lt = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      launchTemplateName: this.launchTemplateName,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.G4DN, ec2.InstanceSize.XLARGE),
      machineImage: ami,
      role,
      securityGroup: props.ec2Sg,
      userData,
    });

    // Spot via escape hatch — CDK LaunchTemplate doesn't expose instanceMarketOptions
    const cfnLt = lt.node.defaultChild as ec2.CfnLaunchTemplate;
    cfnLt.addPropertyOverride('LaunchTemplateData.InstanceMarketOptions', {
      MarketType: 'spot',
      SpotOptions: { SpotInstanceType: 'one-time', InstanceInterruptionBehavior: 'terminate' },
    });

    new cdk.CfnOutput(this, 'LaunchTemplateName', { value: this.launchTemplateName });
  }
}
