<template>
  <!-- Hidden component that registers a global function to open job info modal -->
  <div style="display:none">
    <Modal 
      ref="dialogRef" 
      removeFromDomOnClose 
      class="p-4"
      :beforeCloseFunction="() => { currentJob.value = null; }"
    >
      <JobInfoPopup
        v-if="currentJob"
        :job="currentJob"
        :meta="meta"
        :closeModal="closeModal"
      />
    </Modal>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { callAdminForthApi } from '@/utils';
import { useAdminforth } from '@/adminforth';
import { Modal } from '@/afcl';
import JobInfoPopup from './JobInfoPopup.vue';
import websocket from '@/websocket';

const adminforth = useAdminforth();

const props = defineProps<{
  meta: {
    pluginInstanceId: string;
  }
}>();

const dialogRef = ref<any>(null);
const currentJob = ref<any>(null);

function closeModal() {
  if (!dialogRef.value) return;
  if (typeof dialogRef.value.close === 'function') {
    dialogRef.value.close();
    return;
  }
  if (typeof dialogRef.value.hide === 'function') {
    dialogRef.value.hide();
  }
}

async function openJobInfo(jobId: string) {
  if (!jobId) return;
  try {
    const res = await callAdminForthApi({
      path: `/plugin/${props.meta.pluginInstanceId}/get-job-info`,
      method: 'POST',
      body: { jobId },
    });
    if (res && res.ok) {
      currentJob.value = res.job;
      // open dialog
      if (dialogRef.value && typeof dialogRef.value.open === 'function') {
        dialogRef.value.open();
      } else if (dialogRef.value && typeof dialogRef.value.show === 'function') {
        dialogRef.value.show();
      }
    } else {
      adminforth.alert({ variant: 'danger', message: res?.message || 'Failed to load job info' });
    }
  } catch (e) {
    console.error('OpenJobInfoPopup error', e);
    adminforth.alert({ variant: 'danger', message: 'Failed to load job info' });
  }
}

onMounted(() => {
  // expose global function
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  window.OpenJobInfoPopup = openJobInfo;

  websocket.subscribe('/background-jobs', (data) => {
    if (data.jobId === currentJob.value?.id) {
      if (data.status) { 
        currentJob.value.status = data.status;
      }
      if (data.progress !== undefined) {
        currentJob.value.progress = data.progress;
      }
      if (data.finishedAt) {
        currentJob.value.finishedAt = data.finishedAt;
      }
      if (data.state) {
        currentJob.value.state = {
          ...currentJob.value.state,
          ...data.state,
        };
      }
    }
  });
});
onBeforeUnmount(() => {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  if (window.OpenJobInfoPopup) delete window.OpenJobInfoPopup;
  websocket.unsubscribe('/background-jobs');
});
</script>
