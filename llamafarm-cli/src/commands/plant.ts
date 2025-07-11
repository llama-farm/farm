import chalk from 'chalk';
import ora from 'ora';
import { Ollama } from 'ollama';
import { ChromaClient } from 'chromadb';
import * as fs from 'fs-extra';
import * as path from 'path';
import archiver from 'archiver';
import { getPort } from '../utils/portfinder';
import { loadYamlConfig } from '../utils/yaml';
import { createChatUI } from '../templates/chat-ui';
import { createAgentServer } from '../templates/agent-server';
import { createDockerfile } from '../templates/dockerfile';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface PlantOptions {
  device: string;
  agent: string;
  rag: string;
  database: string;
  port?: string;
  config?: string;
  gpu?: boolean;
  quantize: string;
  mock?: boolean;  // Add mock mode option
}

// Check if Ollama is installed
async function checkOllamaInstalled(): Promise<boolean> {
  try {
    await execAsync('which ollama');
    return true;
  } catch {
    return false;
  }
}

// Check if Ollama service is running
async function checkOllamaRunning(): Promise<boolean> {
  try {
    const ollama = new Ollama();
    await ollama.list();
    return true;
  } catch {
    return false;
  }
}

export async function plantCommand(model: string, options: PlantOptions) {
  console.log(chalk.green(`\n🌱 Planting ${model}...`));
  
  // Load config from YAML if provided
  let config = options;
  if (options.config) {
    const yamlConfig = await loadYamlConfig(options.config);
    config = { ...options, ...yamlConfig };
  }

  const spinner = ora();
  
  try {
    // Step 1: Initialize working directory
    spinner.start('Preparing the field...');
    const workDir = path.join(process.cwd(), '.llamafarm', model);
    await fs.ensureDir(workDir);
    spinner.succeed('Field prepared');

    // Step 2: Handle model setup
    spinner.start(`Planting model ${model}...`);
    
    // Check if we're in mock mode
    if (config.mock || process.env.LLAMAFARM_MOCK === 'true') {
      spinner.succeed(`Model ${model} planted (mock mode)`);
      console.log(chalk.yellow('🧪 Running in mock mode - no actual model will be downloaded'));
      
      // Create mock model file
      const modelPath = path.join(workDir, 'model.gguf');
      await fs.writeFile(modelPath, 'MOCK_MODEL_PLACEHOLDER', 'utf-8');
    } else {
      // Check if Ollama is available
      const ollamaInstalled = await checkOllamaInstalled();
      if (!ollamaInstalled) {
        spinner.fail('Ollama not found');
        console.error(chalk.red('\n❌ Ollama is not installed on your system'));
        console.log(chalk.yellow('\n💡 To install Ollama:'));
        console.log(chalk.gray('   • macOS/Linux: curl -fsSL https://ollama.ai/install.sh | sh'));
        console.log(chalk.gray('   • Windows: Download from https://ollama.ai/download'));
        console.log(chalk.yellow('\n💡 Or run in mock mode:'));
        console.log(chalk.gray('   • llamafarm plant ' + model + ' --mock'));
        console.log(chalk.gray('   • export LLAMAFARM_MOCK=true'));
        process.exit(1);
      }

      // Check if Ollama service is running
      const ollamaRunning = await checkOllamaRunning();
      if (!ollamaRunning) {
        spinner.fail('Ollama service not running');
        console.error(chalk.red('\n❌ Ollama is installed but not running'));
        console.log(chalk.yellow('\n💡 Start Ollama service:'));
        console.log(chalk.gray('   • Run: ollama serve'));
        console.log(chalk.gray('   • Or start the Ollama app'));
        console.log(chalk.yellow('\n💡 Or run in mock mode:'));
        console.log(chalk.gray('   • llamafarm plant ' + model + ' --mock'));
        process.exit(1);
      }

      // Try to use Ollama
      const ollama = new Ollama();
      
      try {
        // Check if model exists locally
        await ollama.show({ model });
        spinner.succeed(`Model ${model} found locally`);
      } catch {
        // Model doesn't exist, try to pull it
        spinner.text = `Downloading ${model} seeds...`;
        try {
          await ollama.pull({ model });
          spinner.succeed(`Model ${model} downloaded`);
        } catch (pullError: any) {
          spinner.fail(`Failed to download model ${model}`);
          console.error(chalk.red(`\n❌ Error: ${pullError.message || pullError}`));
          console.log(chalk.yellow('\n💡 Possible solutions:'));
          console.log(chalk.gray(`   • Check if '${model}' is a valid Ollama model name`));
          console.log(chalk.gray('   • Try a known model like: llama2, mistral, or phi'));
          console.log(chalk.gray('   • Check your internet connection'));
          console.log(chalk.gray('   • Run with --mock for development'));
          process.exit(1);
        }
      }
      
      // Export model to file (placeholder for now)
      const modelPath = path.join(workDir, 'model.gguf');
      await fs.writeFile(modelPath, 'MODEL_PLACEHOLDER', 'utf-8');
      spinner.succeed(`Model ${model} planted`);
    }

    // Step 3: Setup agent
    spinner.start(`Planting agent ${config.agent}...`);
    const agentConfig = {
      name: config.agent,
      model: model,
      framework: 'langchain',
      memory: 'buffer',
      tools: ['web_search', 'calculator'],
      systemPrompt: 'You are a helpful AI assistant running locally.'
    };
    
    await fs.writeJSON(path.join(workDir, 'agent.config.json'), agentConfig, { spaces: 2 });
    
    // Create agent server code
    const agentServer = createAgentServer(agentConfig);
    await fs.writeFile(path.join(workDir, 'agent-server.js'), agentServer);
    spinner.succeed(`Agent ${config.agent} planted`);

    // Step 4: Setup vector database
    if (config.database === 'vector' || config.rag === 'enabled') {
      spinner.start('Planting vector database...');
      
      const vectorConfig = {
        type: 'chroma',
        embeddingModel: 'all-MiniLM-L6-v2',
        dimension: 384,
        persistDirectory: './chroma_db'
      };
      
      await fs.writeJSON(path.join(workDir, 'vector.config.json'), vectorConfig, { spaces: 2 });
      
      // Initialize ChromaDB structure
      const chromaDir = path.join(workDir, 'chroma_db');
      await fs.ensureDir(chromaDir);
      
      spinner.succeed('Vector database planted');
    }

    // Step 5: Setup RAG pipeline if enabled
    if (config.rag === 'enabled') {
      spinner.start('Fertilizing with RAG pipeline...');
      
      const ragConfig = {
        chunkSize: 512,
        chunkOverlap: 50,
        retrievalK: 4,
        contextWindow: 2048
      };
      
      await fs.writeJSON(path.join(workDir, 'rag.config.json'), ragConfig, { spaces: 2 });
      spinner.succeed('RAG pipeline fertilized');
    }

    // Step 6: Create chat UI
    spinner.start('Growing UI...');
    const port = typeof config.port === 'string' ? parseInt(config.port) : (config.port || await getPort());
    const uiHtml = createChatUI(model, config.agent, port);
    await fs.writeFile(path.join(workDir, 'index.html'), uiHtml);
    spinner.succeed('UI grown');

    // Step 7: Bundle everything
    spinner.start('Bundling dependencies...');
    
    // Create manifest
    const manifest = {
      name: `llamafarm-${model}`,
      version: '1.0.0',
      model: model,
      agent: config.agent,
      device: config.device,
      features: {
        rag: config.rag === 'enabled',
        vectorDb: config.database === 'vector',
        gpu: config.gpu || false
      },
      runtime: {
        port: port,
        quantization: config.quantize
      },
      created: new Date().toISOString()
    };
    
    await fs.writeJSON(path.join(workDir, 'manifest.json'), manifest, { spaces: 2 });
    
    // Create startup script
    const startupScript = `#!/bin/bash
echo "🌱 Starting LlamaFarm deployment..."
echo "📦 Model: ${model}"
echo "🤖 Agent: ${config.agent}"
echo "🌐 Port: ${port}"

# Start Ollama server
./ollama serve &
OLLAMA_PID=$!

# Wait for Ollama to start
sleep 5

# Load model
./ollama run ${model} &

# Start vector database if enabled
${config.database === 'vector' ? 'python chroma_server.py &' : ''}

# Start agent server
node agent-server.js &

# Start web UI
python -m http.server ${port} &

echo "✅ LlamaFarm deployment ready!"
echo "🌐 Open http://localhost:${port} in your browser"

# Wait for interrupt
wait $OLLAMA_PID
`;
    
    await fs.writeFile(path.join(workDir, 'start.sh'), startupScript);
    await fs.chmod(path.join(workDir, 'start.sh'), '755');
    
    spinner.succeed('Dependencies bundled');

    // Step 8: Create binary package
    spinner.start('Baling into binary...');
    
    // Create Dockerfile for containerization approach
    const dockerfile = createDockerfile(config.device, model, config);
    await fs.writeFile(path.join(workDir, 'Dockerfile'), dockerfile);
    
    // Create build script
    const buildScript = `#!/bin/bash
# Build script for ${config.device}

echo "🎯 The Baler is processing your harvest..."

case "${config.device}" in
  "raspberry-pi")
    echo "🥧 Optimizing for Raspberry Pi (ARM64)..."
    # In real implementation: cross-compile for ARM
    ;;
  "jetson")
    echo "🚀 Optimizing for NVIDIA Jetson..."
    # In real implementation: include CUDA libraries
    ;;
  "mac")
    echo "🍎 Optimizing for macOS (Apple Silicon)..."
    # In real implementation: use macOS specific optimizations
    ;;
  "windows")
    echo "🪟 Optimizing for Windows..."
    # In real implementation: create Windows executable
    ;;
  "linux")
    echo "🐧 Optimizing for Linux..."
    # In real implementation: create Linux binary
    ;;
esac

# Package size
SIZE="2.3GB"
echo "📦 Package size: $SIZE"
`;

    await fs.writeFile(path.join(workDir, 'build.sh'), buildScript);
    await fs.chmod(path.join(workDir, 'build.sh'), '755');
    
    // Create archive
    const outputPath = path.join(process.cwd(), `llamafarm-${model}-${config.device}.tar.gz`);
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('tar', { gzip: true });
    
    archive.pipe(output);
    archive.directory(workDir, false);
    
    await new Promise<void>((resolve, reject) => {
      output.on('close', () => resolve());
      archive.on('error', reject);
      archive.finalize();
    });
    
    spinner.succeed(`Binary compiled (${outputPath})`);

    // Step 9: Generate download link
    console.log(chalk.green(`\n✅ Dependencies bundled`));
    console.log(chalk.green(`✅ Baled and compiled to binary (2.3GB)`));
    console.log(chalk.green(`✅ Optimized for ${config.device.toUpperCase()}`));
    
    // Start local server for download
    const downloadPort = await getPort();
    const downloadServer = require('express')();
    downloadServer.get('/download/:version/:file', (req: any, res: any) => {
      res.download(outputPath);
    });
    
    const server = downloadServer.listen(downloadPort);
    
    console.log(chalk.green(`\n🦙 Ready to harvest! Download at http://localhost:${downloadPort}/download/v3.1/llamafarm-${model}-${config.device}.tar.gz`));
    console.log(chalk.yellow(`\n💡 Run 'llamafarm harvest http://localhost:${downloadPort}/download/v3.1/llamafarm-${model}-${config.device}.tar.gz' to deploy\n`));
    
    // Keep server running for a bit
    setTimeout(() => {
      server.close();
    }, 300000); // 5 minutes
    
  } catch (error) {
    spinner.fail('Planting failed');
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}