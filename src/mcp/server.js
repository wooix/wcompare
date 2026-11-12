const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { callControl } = require('./client');

const server = new McpServer({ name: 'wcompare', version: '1.0.0' });
const windowId = z.number().int().positive().optional().describe('Window ID returned by get_state or open_arxiv. Required when multiple windows exist.');
function tool(name, description, schema, method, map = args => args, readOnly = false) {
  server.registerTool(`wcompare_${name}`, {
    description, inputSchema: schema,
    annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: !readOnly },
  }, async args => {
    try {
      const value = await callControl(method, map(args));
      const result = Array.isArray(value) ? { jobs: value } : value;
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error.message || error) }] }; }
  });
}
tool('get_state', 'Read open wcompare windows, document paths and PDF view state. Does not start translation or explanation.', {}, 'get_state', undefined, true);
tool('open_arxiv', 'Download an arXiv paper and open its PDF in a new wcompare window. Accepts an arXiv ID or abs/pdf/html URL; preserves explicit versions. Reuses downloads unless refresh=true. Does not start AI work.', {
  url: z.string().min(1), refresh: z.boolean().default(false),
}, 'open_arxiv');
for (const operation of ['translate', 'explain', 'summarize']) {
  const descriptions = {
    translate: 'Run wcompare\'s configured PDF translation process and open the Korean output beside the source.',
    explain: 'Run wcompare\'s predefined paper-helper explanation process and display its validated HTML with the PDF.',
    summarize: 'Run wcompare\'s configured paper summary process and display the summary panel.',
  };
  const schema = { window_id: windowId, force: z.boolean().default(false) };
  if (operation === 'summarize') schema.kinds = z.array(z.enum(['overview', 'narrative', 'sections', 'flow'])).min(1).optional();
  tool(operation, descriptions[operation] + ' Starts a background job and returns its id. Use wait_job/get_job until succeeded, failed, cancelled or interrupted. Reuse existing output unless force=true. Only call when the user requests this action.',
    schema, 'start_job', args => ({ ...args, operation }));
}
tool('get_job', 'Read a job status, progress, result or error.', { job_id: z.string().uuid() }, 'get_job', undefined, true);
tool('wait_job', 'Wait up to 25 seconds for a terminal job state; returns current progress on timeout. Continue waiting while the job is running.', {
  job_id: z.string().uuid(), seconds: z.number().min(0).max(25).default(20),
}, 'wait_job', undefined, true);
tool('list_jobs', 'List recent wcompare jobs, including interrupted jobs from a previous app run.', {}, 'list_jobs', undefined, true);
tool('cancel_job', 'Cancel the specified wcompare job and its worker process. Existing finished output is preserved.', { job_id: z.string().uuid() }, 'cancel_job');
tool('set_view', 'Change PDF layout, summary visibility or which member of the source/translation pair is shown. Does not start AI work.', {
  window_id: windowId, layout: z.enum(['compare', 'explain']).optional(),
  summary_visible: z.boolean().optional(), document: z.enum(['original', 'translation']).optional(),
}, 'set_view');

server.connect(new StdioServerTransport()).catch(error => { console.error(error.message); process.exitCode = 1; });
