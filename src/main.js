const core = require('@actions/core');
const exec = require('@actions/exec');
const github = require('@actions/github');
const lcovTotal = require("lcov-total");

const events = ['pull_request', 'pull_request_target'];

async function run() {
  try {
    const titlePrefix = core.getInput('title-prefix');
    const additionalMessage = core.getInput('additional-message');
    const updateComment = core.getInput('update-comment') === 'true';

    const coverageFile = core.getInput("merged-coverage-file");
    const totalCoverage = lcovTotal(coverageFile);
    const minimumCoverage = core.getInput('minimum-coverage');
    const gitHubToken = core.getInput('github-token').trim();
    const errorMessage = `The code coverage is too low: ${totalCoverage}. Expected at least ${minimumCoverage}.`;
    const isMinimumCoverageReached = totalCoverage >= minimumCoverage;

    const hasGithubToken = gitHubToken !== '';
    const isPR = events.includes(github.context.eventName);

    if (hasGithubToken && isPR) {
      const octokit = await github.getOctokit(gitHubToken);
      const summary = await summarize(coverageFile);
      const details = await detail(coverageFile, octokit);
      const sha = github.context.payload.pull_request.head.sha;
      const shaShort = sha.substr(0, 7);
      const commentHeaderPrefix = `### ${titlePrefix ? `${titlePrefix} ` : ''}[LCOV](https://github.com/marketplace/actions/report-lcov) of commit`;
      let body = `${commentHeaderPrefix} [<code>${shaShort}</code>](${github.context.payload.pull_request.number}/commits/${sha}) during [${github.context.workflow} #${github.context.runNumber}](../actions/runs/${github.context.runId})\n<pre>${summary}\n\nFiles changed coverage rate:${details}</pre>${additionalMessage ? `\n${additionalMessage}` : ''}`;

      if (!isMinimumCoverageReached) {
        body += `\n:no_entry: ${errorMessage}`;
      }

      updateComment ? await upsertComment(body, commentHeaderPrefix, octokit) : await createComment(body, octokit);
    } else if (!hasGithubToken) {
      core.info("github-token received is empty. Skipping writing a comment in the PR.");
      core.info("Note: This could happen even if github-token was provided in workflow file. It could be because your github token does not have permissions for commenting in target repo.")
    } else if (!isPR) {
      core.info("The event is not a pull request. Skipping writing a comment.");
      core.info("The event type is: " + github.context.eventName);
    }

    core.setOutput("total-coverage", totalCoverage);

    if (!isMinimumCoverageReached) {
      throw Error(errorMessage);
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

async function createComment(body, octokit) {
  core.debug("Creating a comment in the PR.")

  await octokit.rest.issues.createComment({
    repo: github.context.repo.repo,
    owner: github.context.repo.owner,
    issue_number: github.context.payload.pull_request.number,
    body,
  });
}

async function upsertComment(body, commentHeaderPrefix, octokit) {
  const issueComments = await octokit.rest.issues.listComments({
    repo: github.context.repo.repo,
    owner: github.context.repo.owner,
    issue_number: github.context.payload.pull_request.number,
  });

  const existingComment = issueComments.data.find(comment =>
    comment.body.includes(commentHeaderPrefix),
  );

  if (existingComment) {
    core.debug(`Updating comment, id: ${existingComment.id}.`);

    await octokit.rest.issues.updateComment({
      repo: github.context.repo.repo,
      owner: github.context.repo.owner,
      comment_id: existingComment.id,
      body,
    });
  } else {
    core.debug(`Comment does not exist, a new comment will be created.`);

    await createComment(body, octokit);
  }
}

async function summarize(coverageFile) {
  let output = '';

  const options = {};
  options.listeners = {
    stdout: (data) => {
      output += data.toString();
    },
    stderr: (data) => {
      output += data.toString();
    }
  };

  await exec.exec('lcov', [
    '--summary',
    coverageFile,
    '--rc',
    'lcov_branch_coverage=1'
  ], options);

  const lines = output
    .trim()
    .split(/\r?\n/)

  lines.shift(); // Removes "Reading tracefile..."

  return lines.join('\n');
}

async function detail(coverageFile, octokit) {
  let output = '';

  const options = {};
  options.listeners = {
    stdout: (data) => {
      output += data.toString();
    },
    stderr: (data) => {
      output += data.toString();
    }
  };

  await exec.exec('lcov', [
    '--list',
    coverageFile,
    '--list-full-path',
    '--rc',
    'lcov_branch_coverage=1',
  ], options);

  let lines = output
    .trim()
    .split(/\r?\n/)

  lines.shift(); // Removes "Reading tracefile..."
  lines.pop(); // Removes "Total..."
  lines.pop(); // Removes "========"

  const listFilesOptions = octokit
    .rest.pulls.listFiles.endpoint.merge({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number: github.context.payload.pull_request.number,
    });
  const listFilesResponse = await octokit.paginate(listFilesOptions);
  const changedFiles = listFilesResponse.map(file => file.filename);

  lines = lines.filter((line, index) => {
    if (index <= 2) return true; // Include header

    for (const changedFile of changedFiles) {
      console.log(`${line} === ${changedFile}`);

      if (line.startsWith(changedFile)) return true;
    }

    return false;
  });

  if (lines.length === 3) { // Only the header remains
    return ' n/a';
  }

  return '\n  ' + lines.join('\n  ');
}

run();
