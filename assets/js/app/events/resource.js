// 资源工具条、上传弹窗、拖拽移动等事件绑定。

import { state } from '../core/state.js';
import { dom } from '../core/dom.js';
import { getGithubToken } from '../core/utils.js';
import { RESOURCE_ROOT } from '../data/repo-tree.js';
import { endResourceDrag, filterResourceItems, isResourceMoveTargetAllowed, moveResourceFile } from '../views/resource-tree.js';
import { closeResourceUploadModal, commitPendingResources, commitPendingVisibility, openResourceUploadModal, pickResourceFiles, queueResourceFolder, updateResourceUploadHint } from '../data/resource-queue.js';

export function bindResourceEvents() {
    // 资源搜索事件
    dom.resourceSearchInput.addEventListener('input', (e) => {
        filterResourceItems(e.target.value);
    });

    dom.resourceSearchClear.addEventListener('click', () => {
        dom.resourceSearchInput.value = '';
        filterResourceItems('');
        dom.resourceSearchClear.style.display = 'none';
    });

    // 资源工具条：上传 / 新建文件夹
    dom.resourceUploadFolder.addEventListener('change', () => {
        state.resourceUploadTarget = dom.resourceUploadFolder.value || RESOURCE_ROOT;
        updateResourceUploadHint();
    });

    dom.resourceUploadBtn.addEventListener('click', () => {
        openResourceUploadModal();
    });

    dom.resourceUploadChoose.addEventListener('click', () => {
        const target = dom.resourceUploadFolder.value || RESOURCE_ROOT;
        state.resourceUploadTarget = target;
        closeResourceUploadModal();
        pickResourceFiles(target);
    });

    dom.resourceUploadCancel.addEventListener('click', closeResourceUploadModal);

    dom.resourceUploadModal.addEventListener('click', (event) => {
        if (event.target === dom.resourceUploadModal) closeResourceUploadModal();
    });

    dom.resourceUploadNewFolder.addEventListener('click', () => {
        if (!getGithubToken()) {
            alert('请先登录后再新建文件夹');
            return;
        }
        const parent = dom.resourceUploadFolder.value || RESOURCE_ROOT;
        const rawName = prompt(`在 ${parent} 下新建文件夹名称（支持多级，如 images/2026）：`);
        if (rawName && rawName.trim()) queueResourceFolder(parent, rawName.trim());
    });

    dom.resourceNewFolderBtn.addEventListener('click', () => {
        if (!getGithubToken()) {
            alert('请先登录后再新建文件夹');
            return;
        }
        const rawName = prompt('请输入资源文件夹名称（支持多级，如 images/2026）：');
        if (rawName && rawName.trim()) queueResourceFolder(RESOURCE_ROOT, rawName.trim());
    });

    // 提交待上传的资源
    dom.resourceCommitBtn.addEventListener('click', async () => {
        await commitPendingResources();
    });

    // 提交文件栏批量勾选的显示状态
    dom.visibilityCommitBtn.addEventListener('click', async () => {
        await commitPendingVisibility();
    });

    // 拖到资源树的空白处 = 移动到资源根目录（具体项由各自的 dragover/drop 处理）
    dom.resourceTree.addEventListener('dragover', (e) => {
        if (!state.resourceDragState) return;
        if (e.target.closest('.tree-item')) return;
        if (!isResourceMoveTargetAllowed(state.resourceDragState.path, RESOURCE_ROOT)) {
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'not-allowed';
            return;
        }
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        dom.resourceTree.classList.add('drop-hover');
    });
    dom.resourceTree.addEventListener('dragleave', (e) => {
        if (dom.resourceTree.contains(e.relatedTarget)) return;
        dom.resourceTree.classList.remove('drop-hover');
    });
    dom.resourceTree.addEventListener('drop', (e) => {
        if (!state.resourceDragState) return;
        if (e.target.closest('.tree-item')) return;
        e.preventDefault();
        const dragged = state.state.resourceDragState;
        endResourceDrag();
        moveResourceFile(dragged.path, RESOURCE_ROOT);
    });
}
